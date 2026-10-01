import { appendRecords, appendTarget, dayDir, sealDay } from './column-store.js'
import { dayEndMs, isDay } from './days.js'
import { removeIfExists } from './fs-utils.js'
import { isAppName, isColumnName } from './names.js'
import { join } from './paths.js'
import { MAX_RECORD_AGE_MS } from './records.js'
import { enforceRetention, listStoredDays } from './retention.js'
import { listClosedSegments, readAppliedSegment, writeAppliedSegment } from './wal.js'

export const DEFAULT_SEAL_DELAY_MS = MAX_RECORD_AGE_MS + 600_000

export const DEFAULT_MAINTENANCE_MS = 60_000

const RETRY_MS = 5_000

const IDLE_MS = 1_000

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

export const applySegment = async ({ dataDir, segment, text, log }) => {
  let rows = 0
  for (const group of parseSegment(text, log)) {
    const target = await appendTarget(dayDir(dataDir, group.app, group.day))
    const applied = await appendRecords({
      dir: target.dir,
      segment,
      records: group.records,
      appliedWal: target.appliedWal,
    })
    if (applied) rows += group.records.length
    else log?.warn(`Log part ${segment} is already stored in ${group.app}/${group.day}, skipped`)
  }
  return rows
}

export const sealDueDays = async ({ dataDir, now, sealDelayMs, log }) => {
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
      if (await sealDay(dayDir(dataDir, app, day))) {
        sealed.push(`${app}/${day}`)
        log?.info(`Sealed ${app}/${day}`)
      }
    } catch (error) {
      log?.error(`Cannot seal ${app}/${day}: ${error.message}`)
    }
  }
  return sealed
}

export const createStorage = ({
  dataDir,
  minFree,
  sealDelayMs = DEFAULT_SEAL_DELAY_MS,
  maintenanceMs = DEFAULT_MAINTENANCE_MS,
  usage,
  now = Date.now,
  log,
  onStatus = () => {},
}) => {
  const walDir = join(dataDir, 'wal')
  let stopping = false
  let wake = null
  let woken = false
  let lastMaintenance = -Infinity
  let lastSeal = -Infinity
  const status = {
    pendingSegments: 0,
    processedRows: 0,
    lastProcessedAt: null,
    lastError: null,
    disk: null,
    retentionError: null,
  }

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

  const processPending = async () => {
    const applied = await readAppliedSegment(walDir)
    const segments = await listClosedSegments(walDir)
    status.pendingSegments = segments.length
    for (const segment of segments) {
      if (stopping) return
      if (segment.id > applied) {
        const text = await Deno.readTextFile(segment.path)
        status.processedRows += await applySegment({ dataDir, segment: segment.id, text, log })
        await writeAppliedSegment(walDir, segment.id)
      }
      await removeIfExists(segment.path)
      status.pendingSegments--
      status.lastProcessedAt = new Date(now()).toISOString()
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
      let delay = IDLE_MS
      if (now() - lastMaintenance >= maintenanceMs) {
        lastMaintenance = now()
        await keepFreeSpace()
      }
      try {
        await processPending()
        status.lastError = null
      } catch (error) {
        status.lastError = error.message
        log?.error(`Storage failed, retrying in ${RETRY_MS / 1000} s: ${error.message}`)
        delay = RETRY_MS
      }
      if (!stopping && delay === IDLE_MS && now() - lastSeal >= maintenanceMs) {
        lastSeal = now()
        await sealDueDays({ dataDir, now: now(), sealDelayMs, log })
      }
      onStatus({ ...status })
      if (!stopping) await sleep(delay)
    }
  }

  return {
    run,
    wake: wakeUp,
    stop: () => {
      stopping = true
      wakeUp()
    },
    status: () => ({ ...status }),
  }
}
