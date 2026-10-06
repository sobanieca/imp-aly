import { dayDir, listDays, readDay, readDaySummary } from './column-store.js'
import { COUNT_MEASURES, forEachVisitLine, tableLines } from './summary.js'
import { decodeValue } from './rle.js'
import { canUseSummary, createAggregate, groupParts, MAX_GROUPS, QueryError } from './query-core.js'

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

export const runQuery = async ({ dataDir, query }) => {
  const { app, from, to, measures } = query
  const wantsVisits = measures.includes('visits')
  const useSummary = canUseSummary(query)
  const aggregate = createAggregate()

  const days = (await listDays(dataDir, app)).filter((day) => day >= from && day <= to)
  let scanned = 0
  let matched = 0
  let summaryDays = 0
  const skippedDays = []
  for (const day of days) {
    const path = dayDir(dataDir, app, day)
    const draft = createAggregate()
    let summary = null
    let result
    try {
      summary = useSummary ? await readDaySummary(path, { withVisits: wantsVisits }) : null
      result = summary
        ? summaryDay({ summary, day, query, aggregate: draft, wantsVisits })
        : await scanDay({ path, day, query, aggregate: draft, wantsVisits })
    } catch (error) {
      skippedDays.push({ day, reason: error.message })
      continue
    }
    for (const group of draft.groups.values()) aggregate.merge(group)
    if (aggregate.groups.size > MAX_GROUPS) {
      throw new QueryError(
        `the query makes more than ${MAX_GROUPS} groups - group by fewer fields or use a shorter range`,
      )
    }
    if (summary) summaryDays++
    scanned += result.scanned
    matched += result.matched
  }

  return {
    app,
    from,
    to,
    days,
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
