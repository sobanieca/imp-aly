import { restoreBackup } from './backup.js'
import { appendRecords, appendTarget, sealDay, sourceDir } from './column-store.js'
import { dayEndMs, isDay, PERIOD_KINDS, periodOf } from './days.js'
import { listDirectory, removeIfExists, writeFileAtomic } from './fs-utils.js'
import { isAppName, isColumnName, isSource } from './names.js'
import { join } from './paths.js'
import { DEFAULT_SEAL_DELAY_MS } from './records.js'
import { duePeriods, updatePeriodSummary } from './periods.js'
import { enforceRetention, listStoredDays } from './retention.js'
import {
  listClosedSegments,
  readAppliedSegment,
  segmentFileName,
  writeAppliedSegment,
} from './wal.js'

export const DEFAULT_MAINTENANCE_MS = 60_000

const RETRY_MS = 5_000

const IDLE_MS = 1_000

const READ_ATTEMPTS = 3

export const HELD_DIR = 'held'

export const UNREADABLE_SUFFIX = '.unreadable'

const decoder = new TextDecoder()

export const heldDir = (dataDir, app, day) => join(dataDir, 'wal', HELD_DIR, app, day)

export const parseSegment = (text, log) => {
  const groups = new Map()
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    if (!Array.isArray(entry) || entry.length !== 3) {
      skipped++
      continue
    }
    const [app, day, input] = entry
    if (!isAppName(app) || !isDay(day) || input === null || typeof input !== 'object') {
      skipped++
      continue
    }
    const record = {}
    for (const [key, value] of Object.entries(input)) {
      if (isColumnName(key) && (typeof value === 'string' || typeof value === 'number')) {
        record[key] = value
      }
    }
    const key = `${app}/${day}`
    if (!groups.has(key)) groups.set(key, { app, day, records: [] })
    groups.get(key).records.push(record)
  }
  if (skipped) log?.warn(`Skipped ${skipped} unreadable lines of the write-ahead log`)
  return [...groups.values()]
}

const applyGroup = async ({ dataDir, source, segment, group, log }) => {
  const target = await appendTarget(sourceDir(dataDir, group.app, group.day, source))
  if (!target) {
    log?.warn(
      `Dropped ${group.records.length} records of ${group.app}/${group.day}: only the daily summary of the day is stored`,
    )
    return 0
  }
  const applied = await appendRecords({
    dir: target.dir,
    segment,
    records: group.records,
    appliedWal: target.appliedWal,
  })
  if (applied) return group.records.length
  log?.warn(`Log part ${segment} is already stored in ${group.app}/${group.day}, skipped`)
  return 0
}

const holdGroup = async ({ dataDir, segment, group }) => {
  const dir = heldDir(dataDir, group.app, group.day)
  await Deno.mkdir(dir, { recursive: true })
  const text = group.records.map((record) => `${JSON.stringify(record)}\n`).join('')
  await writeFileAtomic(join(dir, segmentFileName(segment, 'log')), text)
}

const checkSource = (source) => {
  if (!isSource(source)) throw new Error(`the storage needs a source id, not ${source}`)
}

export const applySegment = async ({ dataDir, source, segment, text, log, held = new Map() }) => {
  checkSource(source)
  let rows = 0
  for (const group of parseSegment(text, log)) {
    const key = `${group.app}/${group.day}`
    if (!held.has(key)) {
      try {
        rows += await applyGroup({ dataDir, source, segment, group, log })
        continue
      } catch (error) {
        held.set(key, error.message)
        log?.error(
          `Cannot store ${key}, kept its records aside to try again later: ${error.message}`,
        )
      }
    }
    await holdGroup({ dataDir, segment, group })
  }
  return rows
}

export const listHeldDays = async (dataDir) => {
  const held = []
  for (const app of await listDirectory(join(dataDir, 'wal', HELD_DIR))) {
    if (!app.isDirectory || !isAppName(app.name)) continue
    for (const day of await listDirectory(join(dataDir, 'wal', HELD_DIR, app.name))) {
      if (day.isDirectory && isDay(day.name)) held.push(`${app.name}/${day.name}`)
    }
  }
  return held
}

export const retryHeldDay = async ({ dataDir, source, key, log }) => {
  const [app, day] = key.split('/')
  const dir = heldDir(dataDir, app, day)
  let rows = 0
  for (const segment of await listClosedSegments(dir)) {
    const text = await Deno.readTextFile(segment.path)
    const records = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    rows += await applyGroup({
      dataDir,
      source,
      segment: segment.id,
      group: { app, day, records },
      log,
    })
    await removeIfExists(segment.path)
  }
  await removeIfExists(dir, { recursive: true })
  return rows
}

export const sealDueDays = async ({ dataDir, source, now, sealDelayMs, log }) => {
  const sealed = []
  let days = []
  try {
    days = await listStoredDays(dataDir)
  } catch (error) {
    log?.error(`Cannot list the stored days: ${error.message}`)
  }
  for (const { app, day } of days) {
    if (now < dayEndMs(day) + sealDelayMs) continue
    try {
      if (await sealDay(sourceDir(dataDir, app, day, source))) {
        sealed.push(`${app}/${day}`)
        log?.info(`Sealed ${app}/${day}`)
      }
    } catch (error) {
      log?.error(`Cannot seal ${app}/${day}: ${error.message}`)
    }
  }
  return sealed
}

export const sealDuePeriods = async (
  { dataDir, source, now, sealDelayMs, checked = new Set(), log },
) => {
  const built = []
  let days = []
  try {
    days = await listStoredDays(dataDir)
  } catch (error) {
    log?.error(`Cannot list the stored days: ${error.message}`)
  }
  for (const [key, period] of duePeriods({ days, now, sealDelayMs, checked })) {
    try {
      if (await updatePeriodSummary({ dataDir, source, ...period })) {
        built.push(key)
        log?.info(`Made the summary of ${key}`)
      }
      checked.add(key)
    } catch (error) {
      log?.error(`Cannot make the summary of ${key}: ${error.message}`)
    }
  }
  return built
}

const periodKeysOf = (sealed) =>
  sealed.flatMap((key) => {
    const [app, day] = key.split('/')
    return PERIOD_KINDS.map((kind) => `${app}/${kind}/${periodOf(kind, day)}`)
  })

export const createStorage = ({
  dataDir,
  source,
  minFree,
  sealDelayMs = DEFAULT_SEAL_DELAY_MS,
  maintenanceMs = DEFAULT_MAINTENANCE_MS,
  retryMs = RETRY_MS,
  usage,
  now = Date.now,
  log,
  onStatus = () => {},
}) => {
  checkSource(source)
  const walDir = join(dataDir, 'wal')
  let stopping = false
  let wake = null
  let woken = false
  let lastMaintenance = -Infinity
  let lastSeal = -Infinity
  let lastHeldRetry = -Infinity
  let heldLoaded = false
  const held = new Map()
  const readFailures = new Map()
  const restores = []
  const checkedPeriods = new Set()
  const status = {
    pendingSegments: 0,
    processedRows: 0,
    lastProcessedAt: null,
    lastError: null,
    unreadableSegments: 0,
    disk: null,
    retentionError: null,
  }

  const snapshot = () => ({
    ...status,
    heldDays: [...held].map(([day, error]) => ({ day, error })),
  })

  const sleep = (ms) =>
    new Promise((resolve) => {
      if (woken) {
        woken = false
        resolve()
        return
      }
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        wake = null
        woken = false
        resolve()
      }
      wake = done
    })

  const wakeUp = () => {
    if (wake) wake()
    else woken = true
  }

  const readSegment = async (segment) => {
    try {
      const bytes = await Deno.readFile(segment.path)
      readFailures.delete(segment.id)
      return decoder.decode(
        segment.validBytes === null ? bytes : bytes.subarray(0, segment.validBytes),
      )
    } catch (error) {
      const failures = (readFailures.get(segment.id) ?? 0) + 1
      readFailures.set(segment.id, failures)
      if (failures < READ_ATTEMPTS) throw error
      readFailures.delete(segment.id)
      await Deno.rename(segment.path, `${segment.path}${UNREADABLE_SUFFIX}`)
      log?.error(
        `Cannot read log part ${segment.id} ${READ_ATTEMPTS} times, renamed it to ${segment.path}${UNREADABLE_SUFFIX}: ${error.message}`,
      )
      return null
    }
  }

  const processPending = async () => {
    if (!heldLoaded) {
      for (const key of await listHeldDays(dataDir)) held.set(key, null)
      heldLoaded = true
    }
    const applied = await readAppliedSegment(walDir)
    const entries = await listDirectory(walDir)
    status.unreadableSegments =
      entries.filter((entry) => entry.name.endsWith(UNREADABLE_SUFFIX)).length
    const segments = await listClosedSegments(walDir)
    status.pendingSegments = segments.length
    for (const segment of segments) {
      if (stopping) return
      const text = segment.id > applied ? await readSegment(segment) : ''
      if (text === null) status.unreadableSegments++
      if (segment.id > applied) {
        if (text) {
          status.processedRows += await applySegment({
            dataDir,
            source,
            segment: segment.id,
            text,
            log,
            held,
          })
        }
        await writeAppliedSegment(walDir, segment.id)
      }
      if (text !== null) await removeIfExists(segment.path)
      status.pendingSegments--
      status.lastProcessedAt = new Date(now()).toISOString()
    }
  }

  const processRestores = async () => {
    while (restores.length && !stopping) {
      const { path, resolve, reject } = restores.shift()
      checkedPeriods.clear()
      try {
        resolve(
          await restoreBackup({
            dataDir,
            open: async () => (await Deno.open(path)).readable,
            now: now(),
            sealDelayMs,
            log,
          }),
        )
      } catch (error) {
        reject(error)
      }
    }
  }

  const retryHeld = async () => {
    for (const [key, previous] of [...held]) {
      if (stopping) return
      try {
        status.processedRows += await retryHeldDay({ dataDir, source, key, log })
        held.delete(key)
        log?.info(`Stored the records of ${key} that were kept aside`)
      } catch (error) {
        if (error.message !== previous) {
          log?.error(`Cannot store the kept records of ${key} yet: ${error.message}`)
        }
        held.set(key, error.message)
      }
    }
  }

  const keepFreeSpace = async () => {
    if (!minFree) return
    try {
      const result = await enforceRetention({ dataDir, minFree, usage, now: now(), log })
      status.disk = {
        totalBytes: result.totalBytes,
        freeBytes: result.freeBytes,
        neededBytes: result.neededBytes,
      }
      status.retentionError = null
    } catch (error) {
      if (status.retentionError !== error.message) {
        log?.warn(`Retention check failed: ${error.message}`)
      }
      status.retentionError = error.message
    }
  }

  const run = async () => {
    while (!stopping) {
      let stored = true
      if (now() - lastMaintenance >= maintenanceMs) {
        lastMaintenance = now()
        await keepFreeSpace()
      }
      try {
        await processPending()
        status.lastError = null
      } catch (error) {
        status.lastError = error.message
        log?.error(`Storage failed, retrying in ${retryMs / 1000} s: ${error.message}`)
        stored = false
      }
      if (!stopping && heldLoaded && held.size && now() - lastHeldRetry >= maintenanceMs) {
        lastHeldRetry = now()
        await retryHeld()
      }
      await processRestores()
      if (!stopping && stored && now() - lastSeal >= maintenanceMs) {
        lastSeal = now()
        const sealed = await sealDueDays({ dataDir, source, now: now(), sealDelayMs, log })
        for (const key of periodKeysOf(sealed)) checkedPeriods.delete(key)
        await sealDuePeriods({
          dataDir,
          source,
          now: now(),
          sealDelayMs,
          checked: checkedPeriods,
          log,
        })
      }
      onStatus(snapshot())
      if (!stopping) await sleep(stored ? IDLE_MS : retryMs)
    }
    for (const { reject } of restores.splice(0)) reject(new Error('the server stops'))
  }

  return {
    run,
    wake: wakeUp,
    restore: (path) =>
      new Promise((resolve, reject) => {
        restores.push({ path, resolve, reject })
        wakeUp()
      }),
    stop: () => {
      stopping = true
      wakeUp()
    },
    status: () => snapshot(),
  }
}
