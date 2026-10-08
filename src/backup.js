import {
  listApps,
  listDays,
  listSources,
  readDaySummary,
  readGenerations,
  sourceDir,
  writeSummaryDay,
  writeSummaryPeriod,
} from './column-store.js'
import {
  addDays,
  addMonths,
  DAY_MS,
  dayEndMs,
  dayOf,
  isDay,
  isPeriodId,
  PERIOD_NAMES,
  periodDays,
} from './days.js'
import { isAppName, isSource } from './names.js'
import { DEFAULT_SEAL_DELAY_MS } from './records.js'
import {
  listPeriods,
  listPeriodSources,
  periodEndMs,
  periodSourceDir,
  readPeriodSummary,
} from './periods.js'
import {
  checkSummary,
  formatPeriodDays,
  parsePeriodDays,
  PERIOD_DAYS_FILE,
  SUMMARY_FILES,
} from './summary.js'
import { readTar, tarEnd, tarEntry } from './tar.js'

export class BackupError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

export const MAX_SUMMARY_FILE_BYTES = 268_435_456

const BACKUP_PARAMS = ['last', 'by']

export const BACKUP_PERIODS = {
  '1d': { days: 1 },
  '7d': { days: 7 },
  '30d': { days: 30 },
  '3m': { months: 3 },
  '6m': { months: 6 },
  '1y': { months: 12 },
  all: {},
}

export const BACKUP_KINDS = { day: 'days', week: 'weeks', month: 'months' }

const PERIOD_FILES = { ...SUMMARY_FILES, days: PERIOD_DAYS_FILE }

const FILES_OF = { days: SUMMARY_FILES, weeks: PERIOD_FILES, months: PERIOD_FILES }

const KIND_OF_FILE = new Map(Object.entries(PERIOD_FILES).map(([kind, file]) => [file, kind]))

const ENTRY_PATTERN = /^([^/]+)\/([^/]+)\/(days|weeks|months)\/([^/]+)\/([^/]+)$/

const ID_NAMES = { days: 'day', ...PERIOD_NAMES }

const isEntryId = (kind, id) => (kind === 'days' ? isDay(id) : isPeriodId(kind, id))

const encoder = new TextEncoder()

export const parseBackupOptions = (params) => {
  const unknown = [...params.keys()].filter((key) => !BACKUP_PARAMS.includes(key))
  if (unknown.length) {
    throw new BackupError(`unknown backup options: ${unknown.join(', ')} - use last and by`)
  }
  const last = params.get('last') ?? 'all'
  const by = params.get('by') ?? 'day'
  if (!Object.hasOwn(BACKUP_PERIODS, last)) {
    throw new BackupError(`last is one of ${Object.keys(BACKUP_PERIODS).join(', ')}`)
  }
  if (!Object.hasOwn(BACKUP_KINDS, by)) {
    throw new BackupError(`by is one of ${Object.keys(BACKUP_KINDS).join(', ')}`)
  }
  return { last, by }
}

export const backupRange = ({ last, now, sealDelayMs }) => {
  const to = dayOf(now - sealDelayMs - DAY_MS)
  const { days, months } = BACKUP_PERIODS[last]
  if (days) return { from: addDays(to, 1 - days), to }
  if (months) return { from: addDays(addMonths(to, -months), 1), to }
  return { from: null, to }
}

export function* summaryEntries({ app, source, kind, id, summary, mtimeMs }) {
  const texts = kind === 'days' ? summary : { ...summary, days: formatPeriodDays(summary.days) }
  for (const [part, file] of Object.entries(FILES_OF[kind])) {
    yield* tarEntry({
      name: `${app}/${source}/${kind}/${id}/${file}`,
      data: encoder.encode(texts[part]),
      mtimeMs,
    })
  }
}

const inRange = (day, { from, to }) => (from === null || day >= from) && day <= to

async function* dayChunks({ dataDir, app, range, mtimeMs, log }) {
  for (const day of await listDays(dataDir, app)) {
    if (!inRange(day, range)) continue
    for (const source of await listSources(dataDir, app, day)) {
      let summary
      try {
        summary = await readDaySummary(sourceDir(dataDir, app, day, source), { withVisits: true })
      } catch (error) {
        log?.warn(`The backup skipped ${app}/${day}/${source}: ${error.message}`)
        continue
      }
      if (!summary) continue
      yield* summaryEntries({ app, source, kind: 'days', id: day, summary, mtimeMs })
    }
  }
}

const inPeriod = (kind, id, range) => {
  const days = periodDays(kind, id)
  return (range.from === null || days[0] >= range.from) && days.at(-1) <= range.to
}

async function* periodChunks({ dataDir, app, kind, range, mtimeMs, log }) {
  for (const id of await listPeriods(dataDir, app, kind)) {
    if (!inPeriod(kind, id, range)) continue
    for (const source of await listPeriodSources(dataDir, app, kind, id)) {
      let summary
      try {
        summary = await readPeriodSummary(dataDir, app, kind, id, source, { withVisits: true })
      } catch (error) {
        log?.warn(`The backup skipped ${app}/${kind}/${id}/${source}: ${error.message}`)
        continue
      }
      if (!summary) continue
      yield* summaryEntries({ app, source, kind, id, summary, mtimeMs })
    }
  }
}

async function* backupChunks({ dataDir, kind, range, mtimeMs, log }) {
  for (const app of await listApps(dataDir)) {
    const chunks = kind === 'days' ? dayChunks : periodChunks
    yield* chunks({ dataDir, app, kind, range, mtimeMs, log })
  }
  yield tarEnd()
}

export const createBackupStream = (
  { dataDir, last = 'all', by = 'day', now = Date.now(), sealDelayMs = DEFAULT_SEAL_DELAY_MS, log },
) =>
  ReadableStream.from(
    backupChunks({
      dataDir,
      kind: BACKUP_KINDS[by],
      range: backupRange({ last, now, sealDelayMs }),
      mtimeMs: now,
      log,
    }),
  ).pipeThrough(new CompressionStream('gzip'))

const decoder = new TextDecoder('utf-8', { fatal: true })

const finishEntry = ({ key, app, source, kind, id, files }) => {
  const missing = Object.entries(FILES_OF[kind])
    .filter(([part]) => files[part] === undefined)
    .map(([, file]) => file)
  if (missing.length) throw new Error(`${key} has no ${missing.join(', ')}`)
  try {
    const rows = checkSummary(files)
    const entry = { app, source, kind, id, rows, files }
    if (kind === 'days') return entry
    const { days, rows: dayRows } = parsePeriodDays(files.days, periodDays(kind, id))
    if (dayRows !== rows) throw new Error(`${PERIOD_DAYS_FILE} does not match the counts`)
    const { counts, tuples, visits } = files
    return { ...entry, files: { counts, tuples, visits }, days }
  } catch (error) {
    throw new Error(`${key}: ${error.message}`)
  }
}

async function* backupEntries(stream) {
  const entries = readTar(stream.pipeThrough(new DecompressionStream('gzip')), {
    maxEntryBytes: MAX_SUMMARY_FILE_BYTES,
  })
  const seen = new Set()
  let current = null
  for await (const { name, data } of entries) {
    const match = ENTRY_PATTERN.exec(name)
    if (
      !match || !isAppName(match[1]) || !isSource(match[2]) || !isEntryId(match[3], match[4]) ||
      !Object.values(FILES_OF[match[3]]).includes(match[5])
    ) {
      throw new Error(`${name} is not a summary file of an app and a source`)
    }
    const [, app, source, kind, id, file] = match
    const key = `${app}/${source}/${kind}/${id}`
    if (current?.key !== key) {
      if (current) yield finishEntry(current)
      if (seen.has(key)) throw new Error(`the files of ${key} are not next to each other`)
      seen.add(key)
      current = { key, app, source, kind, id, files: {} }
    }
    const part = KIND_OF_FILE.get(file)
    if (current.files[part] !== undefined) throw new Error(`${name} is in the backup twice`)
    try {
      current.files[part] = decoder.decode(data)
    } catch {
      throw new Error(`${name} is not UTF-8 text`)
    }
  }
  if (current) yield finishEntry(current)
}

export async function* readBackup(stream) {
  try {
    yield* backupEntries(stream)
  } catch (error) {
    throw new BackupError(`the backup is not valid: ${error.message}`)
  }
}

export const countBackup = async (stream) => {
  const apps = new Set()
  const sources = new Set()
  const counts = { days: 0, weeks: 0, months: 0 }
  for await (const entry of readBackup(stream)) {
    apps.add(entry.app)
    sources.add(entry.source)
    counts[entry.kind]++
  }
  return { apps: apps.size, sources: sources.size, ...counts }
}

const restoreDay = async ({ dataDir, entry, now, sealDelayMs }) => {
  if (now < dayEndMs(entry.id) + sealDelayMs) return 'the day is not sealed yet'
  const path = sourceDir(dataDir, entry.app, entry.id, entry.source)
  const { sealed, raws } = await readGenerations(path)
  if (sealed > 0 || raws.length) return 'the server already stores the day of the source'
  await writeSummaryDay(path, { rows: entry.rows, files: entry.files })
  return null
}

const restorePeriod = async ({ dataDir, entry, now, sealDelayMs }) => {
  const name = PERIOD_NAMES[entry.kind]
  if (now < periodEndMs(entry.kind, entry.id) + sealDelayMs) return `the ${name} is not sealed yet`
  const path = periodSourceDir(dataDir, entry.app, entry.kind, entry.id, entry.source)
  const { sealed, raws } = await readGenerations(path)
  if (sealed > 0 || raws.length) return `the server already stores the ${name} of the source`
  const days = Object.fromEntries(
    Object.entries(entry.days).map(([day, { rows }]) => [day, { rows, wal: 0 }]),
  )
  await writeSummaryPeriod(path, { rows: entry.rows, days, files: entry.files })
  return null
}

export const restoreBackup = async ({ dataDir, open, now = Date.now(), sealDelayMs, log }) => {
  await countBackup(await open())
  const restored = []
  const skipped = []
  for await (const entry of readBackup(await open())) {
    const { app, source, kind, id } = entry
    const name = ID_NAMES[kind]
    const write = kind === 'days' ? restoreDay : restorePeriod
    const reason = await write({ dataDir, entry, now, sealDelayMs })
    if (reason) {
      skipped.push({ app, source, [name]: id, reason })
      continue
    }
    restored.push({ app, source, [name]: id })
    log?.info(`Restored the summary of the ${name} ${app}/${id} of the source ${source}`)
  }
  return { restored, skipped }
}
