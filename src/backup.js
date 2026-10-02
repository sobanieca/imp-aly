import {
  dayDir,
  listApps,
  listDays,
  readDaySummary,
  readGenerations,
  writeSummaryDay,
} from './column-store.js'
import { dayEndMs, isDay } from './days.js'
import { isAppName } from './names.js'
import { checkSummary, SUMMARY_FILES } from './summary.js'
import { readTar, tarEnd, tarEntry } from './tar.js'

export class BackupError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

export const MAX_SUMMARY_FILE_BYTES = 268_435_456

const BACKUP_PARAMS = ['app', 'from', 'to']

const KIND_OF_FILE = new Map(Object.entries(SUMMARY_FILES).map(([kind, file]) => [file, kind]))

const ENTRY_PATTERN = /^([^/]+)\/([^/]+)\/([^/]+)$/

const encoder = new TextEncoder()

export const parseBackupOptions = (params) => {
  const unknown = [...params.keys()].filter((key) => !BACKUP_PARAMS.includes(key))
  if (unknown.length) {
    throw new BackupError(`unknown backup options: ${unknown.join(', ')} - use app, from and to`)
  }
  const app = params.get('app')
  const from = params.get('from')
  const to = params.get('to')
  if (app !== null && !isAppName(app)) throw new BackupError('app is the name of an app')
  if (from !== null && !isDay(from)) throw new BackupError('from is a day like 2026-10-01')
  if (to !== null && !isDay(to)) throw new BackupError('to is a day like 2026-10-01')
  if (from !== null && to !== null && from > to) throw new BackupError('from is after to')
  return { app, from, to }
}

async function* backupChunks({ dataDir, app, from, to, mtimeMs, log }) {
  for (const name of app ? [app] : await listApps(dataDir)) {
    for (const day of await listDays(dataDir, name)) {
      if ((from && day < from) || (to && day > to)) continue
      let summary
      try {
        summary = await readDaySummary(dayDir(dataDir, name, day), { withVisits: true })
      } catch (error) {
        log?.warn(`The backup skipped ${name}/${day}: ${error.message}`)
        continue
      }
      if (!summary) continue
      for (const [kind, file] of Object.entries(SUMMARY_FILES)) {
        yield* tarEntry({
          name: `${name}/${day}/${file}`,
          data: encoder.encode(summary[kind]),
          mtimeMs,
        })
      }
    }
  }
  yield tarEnd()
}

export const createBackupStream = ({ dataDir, app, from, to, now = Date.now(), log }) =>
  ReadableStream.from(backupChunks({ dataDir, app, from, to, mtimeMs: now, log }))
    .pipeThrough(new CompressionStream('gzip'))

const decoder = new TextDecoder('utf-8', { fatal: true })

const finishDay = ({ app, day, files }) => {
  const missing = Object.values(SUMMARY_FILES).filter((file) =>
    files[KIND_OF_FILE.get(file)] === undefined
  )
  if (missing.length) throw new Error(`${app}/${day} has no ${missing.join(', ')}`)
  try {
    return { app, day, rows: checkSummary(files), files }
  } catch (error) {
    throw new Error(`${app}/${day}: ${error.message}`)
  }
}

async function* backupDays(stream) {
  const entries = readTar(stream.pipeThrough(new DecompressionStream('gzip')), {
    maxEntryBytes: MAX_SUMMARY_FILE_BYTES,
  })
  const seen = new Set()
  let current = null
  for await (const { name, data } of entries) {
    const match = ENTRY_PATTERN.exec(name)
    if (!match || !isAppName(match[1]) || !isDay(match[2]) || !KIND_OF_FILE.has(match[3])) {
      throw new Error(`${name} is not a daily summary file of an app`)
    }
    const [, app, day, file] = match
    const key = `${app}/${day}`
    if (current?.key !== key) {
      if (current) yield finishDay(current)
      if (seen.has(key)) throw new Error(`the files of ${key} are not next to each other`)
      seen.add(key)
      current = { key, app, day, files: {} }
    }
    const kind = KIND_OF_FILE.get(file)
    if (current.files[kind] !== undefined) throw new Error(`${name} is in the backup twice`)
    try {
      current.files[kind] = decoder.decode(data)
    } catch {
      throw new Error(`${name} is not UTF-8 text`)
    }
  }
  if (current) yield finishDay(current)
}

export async function* readBackup(stream) {
  try {
    yield* backupDays(stream)
  } catch (error) {
    throw new BackupError(`the backup is not valid: ${error.message}`)
  }
}

export const countBackup = async (stream) => {
  const apps = new Set()
  let days = 0
  for await (const entry of readBackup(stream)) {
    apps.add(entry.app)
    days++
  }
  return { apps: apps.size, days }
}

export const restoreBackup = async ({ dataDir, open, now = Date.now(), sealDelayMs, log }) => {
  await countBackup(await open())
  const restored = []
  const skipped = []
  for await (const { app, day, rows, files } of readBackup(await open())) {
    if (now < dayEndMs(day) + sealDelayMs) {
      skipped.push({ app, day, reason: 'the day is not sealed yet' })
      continue
    }
    const path = dayDir(dataDir, app, day)
    const { sealed, raws } = await readGenerations(path)
    if (sealed > 0 || raws.length) {
      skipped.push({ app, day, reason: 'the server already stores the day' })
      continue
    }
    await writeSummaryDay(path, { rows, files })
    restored.push({ app, day })
    log?.info(`Restored the daily summary of ${app}/${day}`)
  }
  return { restored, skipped }
}
