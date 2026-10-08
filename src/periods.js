import {
  appDir,
  listSourcesIn,
  readDaySummary,
  readGenerations,
  readSealedMeta,
  sourceDir,
  writeSummaryPeriod,
} from './column-store.js'
import { dayEndMs, isPeriodId, PERIOD_KINDS, periodDays, periodOf } from './days.js'
import { listDirectory } from './fs-utils.js'
import { join } from './paths.js'
import { createSummaryMerger } from './summary.js'

export const periodsDir = (dataDir, app, kind) => join(appDir(dataDir, app), kind)

export const periodDir = (dataDir, app, kind, id) => join(periodsDir(dataDir, app, kind), id)

export const periodSourceDir = (dataDir, app, kind, id, source) =>
  join(periodDir(dataDir, app, kind, id), source)

export const listPeriods = async (dataDir, app, kind) =>
  (await listDirectory(periodsDir(dataDir, app, kind)))
    .filter((entry) => entry.isDirectory && isPeriodId(kind, entry.name))
    .map((entry) => entry.name)
    .sort()

export const listPeriodSources = (dataDir, app, kind, id) =>
  listSourcesIn(periodDir(dataDir, app, kind, id))

export const periodEndMs = (kind, id) => dayEndMs(periodDays(kind, id).at(-1))

const isCount = (value) => Number.isSafeInteger(value) && value >= 0

export const checkPeriodDays = (kind, id, days) => {
  const allowed = periodDays(kind, id)
  if (
    days === null || typeof days !== 'object' || Array.isArray(days) ||
    Object.entries(days).some(([day, state]) =>
      !allowed.includes(day) || !isCount(state?.rows) || !isCount(state?.wal)
    )
  ) {
    throw new Error(`the days of the summary of ${kind}/${id} are not valid`)
  }
  return days
}

export const readDayStates = async (dataDir, app, kind, id, source) => {
  const days = {}
  for (const day of periodDays(kind, id)) {
    const path = sourceDir(dataDir, app, day, source)
    const { sealed, raws } = await readGenerations(path)
    if (sealed === 0 && !raws.length) continue
    if (raws.length) return null
    let meta
    try {
      meta = await readSealedMeta(join(path, `sealed-${sealed}`))
    } catch {
      return null
    }
    if (meta.summary !== true) return null
    days[day] = { rows: meta.rows, wal: meta.wal }
  }
  return days
}

export const matchesDays = (recorded, states) =>
  states !== null &&
  Object.entries(states).every(([day, state]) =>
    recorded[day]?.rows === state.rows && recorded[day]?.wal === state.wal
  )

export const readPeriodSummary = (dataDir, app, kind, id, source, { withVisits }) =>
  readDaySummary(periodSourceDir(dataDir, app, kind, id, source), {
    withVisits,
    accept: async (meta) =>
      matchesDays(
        checkPeriodDays(kind, id, meta.days),
        await readDayStates(dataDir, app, kind, id, source),
      ),
  })

export const readPeriodDays = async (dataDir, app, kind, id, source) => {
  const path = periodSourceDir(dataDir, app, kind, id, source)
  const { sealed } = await readGenerations(path)
  if (sealed === 0) return {}
  const meta = await readSealedMeta(join(path, `sealed-${sealed}`))
  return checkPeriodDays(kind, id, meta.days)
}

export const updatePeriodSummary = async ({ dataDir, app, kind, id, source }) => {
  const states = await readDayStates(dataDir, app, kind, id, source)
  if (states === null || !Object.keys(states).length) return false
  const path = periodSourceDir(dataDir, app, kind, id, source)
  const { sealed } = await readGenerations(path)
  if (sealed > 0) {
    const recorded = await readPeriodDays(dataDir, app, kind, id, source).catch(() => null)
    if (recorded && matchesDays(recorded, states)) return false
  }
  const merger = createSummaryMerger()
  const days = {}
  for (const day of Object.keys(states)) {
    const summary = await readDaySummary(sourceDir(dataDir, app, day, source), {
      withVisits: true,
    })
    if (!summary) return false
    merger.add(summary)
    days[day] = { rows: summary.rows, wal: summary.wal }
  }
  const { rows, files } = merger.finish()
  await writeSummaryPeriod(path, { rows, days, files })
  return true
}

export const duePeriods = ({ days, now, sealDelayMs, checked }) => {
  const due = new Map()
  for (const { app, day } of days) {
    for (const kind of PERIOD_KINDS) {
      const id = periodOf(kind, day)
      const key = `${app}/${kind}/${id}`
      if (checked.has(key) || due.has(key)) continue
      if (now < periodEndMs(kind, id) + sealDelayMs) continue
      due.set(key, { app, kind, id })
    }
  }
  return due
}
