import { listDays, listSources, readDay, readDaySummary, sourceDir } from './column-store.js'
import { monthOf, PERIOD_KINDS, PERIOD_NAMES, periodDays } from './days.js'
import { listPeriods, listPeriodSources, readPeriodDays, readPeriodSummary } from './periods.js'
import { COUNT_MEASURES, forEachVisitLine, tableLines } from './summary.js'
import { decodeValue } from './rle.js'
import {
  canUseSummary,
  createAggregate,
  groupParts,
  MAX_GROUPS,
  QueryError,
  timeFieldOf,
} from './query-core.js'

const scanDay = async ({ path, day, query, aggregate, wantsVisits }) => {
  const { where, groupBy } = query
  const { fields, time } = groupParts(groupBy, day)
  const columns = new Set([...where.map((filter) => filter.field), ...fields])
  if (wantsVisits) columns.add('visit')
  const { rows, columns: values } = await readDay(path, [...columns])
  const selected = new Uint8Array(rows).fill(1)
  for (const filter of where) {
    const column = values[filter.field]
    for (let row = 0; row < rows; row++) {
      if (selected[row] && !filter.values.has(column[row])) selected[row] = 0
    }
  }
  const groupColumns = groupBy.map((field, index) => (time[index] === null ? values[field] : null))
  const dayVisits = new Map()
  let matched = 0
  for (let row = 0; row < rows; row++) {
    if (!selected[row]) continue
    matched++
    const target = aggregate.group(
      groupColumns.map((column, index) => (column === null ? time[index] : column[row])),
    )
    target.records++
    if (wantsVisits && values.visit[row] !== null) {
      let visits = dayVisits.get(target)
      if (!visits) {
        visits = new Set()
        dayVisits.set(target, visits)
      }
      visits.add(values.visit[row])
    }
  }
  for (const [target, visits] of dayVisits) target.visits += visits.size
  return { scanned: rows, matched }
}

const cellsOf = (header, needed) => {
  const positions = needed.map((field) => header.indexOf(field))
  return (cells) =>
    positions.map((position) => (position === -1 ? null : decodeValue(cells[position])))
}

const summaryDay = ({ summary, day, query, aggregate, wantsVisits }) => {
  const { where, groupBy } = query
  const { fields, time } = groupParts(groupBy, day)
  const needed = [...where.map((filter) => filter.field), ...fields]
  const select = (cells, read) => {
    const values = read(cells)
    for (let index = 0; index < where.length; index++) {
      if (!where[index].values.has(values[index])) return null
    }
    let next = where.length
    return aggregate.group(time.map((value) => value ?? values[next++]))
  }

  const counts = tableLines(summary.counts)
  const readCounts = cellsOf(counts.header, needed)
  const recordsAt = counts.header.length - COUNT_MEASURES.length
  let matched = 0
  for (const line of counts.lines) {
    const cells = line.split('\t')
    const target = select(cells, readCounts)
    if (!target) continue
    const records = Number(cells[recordsAt])
    matched += records
    target.records += records
  }

  if (wantsVisits) {
    const tuples = tableLines(summary.tuples)
    const readTuples = cellsOf(tuples.header, needed)
    const targets = tuples.lines.map((line) => select(line.split('\t'), readTuples))
    forEachVisitLine(summary.visits, (visits, indexes) => {
      const stamp = ++aggregate.stamp
      for (const index of indexes) {
        const target = targets[index]
        if (!target || target.stamp === stamp) continue
        target.stamp = stamp
        target.visits += visits
      }
    })
  }
  return { scanned: summary.rows, matched }
}

const READ_ORDER = ['months', 'weeks']

const periodFits = (kind, days, time) => {
  if (time === null) return true
  if (time === 'week') return kind === 'weeks'
  if (time === 'month') return monthOf(days[0]) === monthOf(days.at(-1))
  return false
}

const listPeriodSummaries = async (dataDir, app, from, to) => {
  const periods = []
  for (const kind of PERIOD_KINDS) {
    for (const id of await listPeriods(dataDir, app, kind)) {
      const days = periodDays(kind, id)
      if (days.at(-1) < from || days[0] > to) continue
      const inside = days[0] >= from && days.at(-1) <= to
      for (const source of await listPeriodSources(dataDir, app, kind, id)) {
        periods.push({ kind, id, days, inside, source })
      }
    }
  }
  return periods
}

export const runQuery = async ({ dataDir, query }) => {
  const { app, from, to, groupBy, measures } = query
  const wantsVisits = measures.includes('visits')
  const useSummary = canUseSummary(query)
  const time = timeFieldOf(groupBy)
  const aggregate = createAggregate()

  const dayFolders = (await listDays(dataDir, app)).filter((day) => day >= from && day <= to)
  const daySources = new Map()
  for (const day of dayFolders) daySources.set(day, await listSources(dataDir, app, day))
  const periods = await listPeriodSummaries(dataDir, app, from, to)
  const sources = [
    ...new Set([...[...daySources.values()].flat(), ...periods.map((period) => period.source)]),
  ].sort()

  const days = new Set(dayFolders)
  const outcomes = new Map()
  const skippedDays = []
  let scanned = 0
  let matched = 0

  const add = (draft, result) => {
    for (const group of draft.groups.values()) aggregate.merge(group)
    if (aggregate.groups.size > MAX_GROUPS) {
      throw new QueryError(
        `the query makes more than ${MAX_GROUPS} groups - group by fewer fields or use a shorter range`,
      )
    }
    scanned += result.scanned
    matched += result.matched
  }
  const mark = (day, source, outcome) => {
    if (!outcomes.has(day)) outcomes.set(day, new Map())
    outcomes.get(day).set(source, outcome)
  }
  const skip = (day, source, reason) => {
    days.add(day)
    mark(day, source, 'skipped')
    skippedDays.push({ day, source, reason })
  }

  for (const source of sources) {
    const own = periods.filter((period) => period.source === source)
    const covered = new Set()
    const used = new Set()
    const problems = new Map()
    for (const kind of useSummary ? READ_ORDER : []) {
      for (const period of own) {
        if (period.kind !== kind || !period.inside || !periodFits(kind, period.days, time)) continue
        if (period.days.some((day) => covered.has(day))) continue
        const draft = createAggregate()
        let summary
        try {
          summary = await readPeriodSummary(dataDir, app, kind, period.id, source, {
            withVisits: wantsVisits,
          })
          if (!summary) continue
          add(
            draft,
            summaryDay({ summary, day: period.days[0], query, aggregate: draft, wantsVisits }),
          )
        } catch (error) {
          if (error instanceof QueryError) throw error
          problems.set(period, error.message)
          continue
        }
        used.add(period)
        for (const day of period.days) covered.add(day)
        for (const day of Object.keys(summary.days)) {
          days.add(day)
          mark(day, source, 'summary')
        }
      }
    }

    for (const day of dayFolders) {
      if (covered.has(day) || !daySources.get(day).includes(source)) continue
      const path = sourceDir(dataDir, app, day, source)
      const draft = createAggregate()
      let summary = null
      let result
      try {
        summary = useSummary ? await readDaySummary(path, { withVisits: wantsVisits }) : null
        result = summary
          ? summaryDay({ summary, day, query, aggregate: draft, wantsVisits })
          : await scanDay({ path, day, query, aggregate: draft, wantsVisits })
      } catch (error) {
        skip(day, source, error.message)
        continue
      }
      add(draft, result)
      mark(day, source, summary ? 'summary' : 'scan')
    }

    for (const period of own) {
      if (used.has(period)) continue
      const missing = (day) =>
        day >= from && day <= to && !covered.has(day) && !outcomes.get(day)?.has(source)
      let reason = problems.get(period) ??
        `only the summary of the ${PERIOD_NAMES[period.kind]} is stored`
      let stored
      try {
        stored = Object.keys(await readPeriodDays(dataDir, app, period.kind, period.id, source))
      } catch (error) {
        reason = error.message
        stored = period.days.filter((day) => !daySources.get(day)?.includes(source))
      }
      for (const day of stored.filter(missing)) skip(day, source, reason)
    }
  }

  const summaryDays =
    [...outcomes.values()].filter((bySource) =>
      [...bySource.values()].every((outcome) => outcome === 'summary')
    ).length
  skippedDays.sort((a, b) =>
    a.day === b.day ? (a.source < b.source ? -1 : 1) : a.day < b.day ? -1 : 1
  )

  return {
    app,
    from,
    to,
    days: [...days].sort(),
    summaryDays,
    scanned,
    matched,
    skippedDays,
    groups: [...aggregate.groups.values()].map((group) => {
      const entry = { by: group.parts, records: group.records }
      if (wantsVisits) entry.visits = group.visits
      return entry
    }),
  }
}
