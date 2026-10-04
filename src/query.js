import { dayDir, listDays, readDay, readDaySummary } from './column-store.js'
import { COUNT_MEASURES, forEachVisitLine, tableLines } from './summary.js'
import { decodeValue } from './rle.js'
import { dayOf, isDay } from './days.js'
import { BASE_COLUMNS, isAppName, RESERVED_NAMES, SEGMENT_NAME_PATTERN } from './names.js'

export class QueryError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

export const DEFAULT_LIMIT = 1_000

export const MAX_LIMIT = 100_000

export const MAX_GROUPS = 100_000

const MAX_WHERE_VALUES = 1_000

const DIMENSIONS = BASE_COLUMNS.filter((column) => column !== 'at')

const TIME_FIELDS = ['day', 'week', 'month']

const MEASURES = ['records', 'visits']

const QUERY_KEYS = ['app', 'from', 'to', 'where', 'groupBy', 'measures', 'limit']

const isDimension = (field) =>
  typeof field === 'string' &&
  (DIMENSIONS.includes(field) ||
    (SEGMENT_NAME_PATTERN.test(field) && !RESERVED_NAMES.has(field)))

const DAY_MS = 86_400_000

const mondayOf = (day) => {
  const time = Date.parse(day)
  const weekday = (new Date(time).getUTCDay() + 6) % 7
  return new Date(time - weekday * DAY_MS).toISOString().slice(0, 10)
}

const TIME_OF = {
  day: (day) => day,
  week: mondayOf,
  month: (day) => day.slice(0, 7),
}

const dimensionHint = () => `${DIMENSIONS.join(', ')} or a segment name`

export const parseQuery = (input, now = Date.now()) => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new QueryError('the query is a JSON object, like {"app": "myapp"}')
  }
  const unknown = Object.keys(input).filter((key) => !QUERY_KEYS.includes(key))
  if (unknown.length) {
    throw new QueryError(
      `unknown query fields: ${unknown.join(', ')} - use ${QUERY_KEYS.join(', ')}`,
    )
  }
  if (!isAppName(input.app)) throw new QueryError('app is the name of a registered app')
  const today = dayOf(now)
  const to = input.to ?? input.from ?? today
  const from = input.from ?? to
  if (!isDay(from)) throw new QueryError('from is a day like 2026-10-01')
  if (!isDay(to)) throw new QueryError('to is a day like 2026-10-01')
  if (from > to) throw new QueryError('from is after to')

  const where = []
  if (input.where !== undefined) {
    if (input.where === null || typeof input.where !== 'object' || Array.isArray(input.where)) {
      throw new QueryError('where is an object, like {"type": "page"}')
    }
    for (const [field, value] of Object.entries(input.where)) {
      if (!isDimension(field)) {
        throw new QueryError(`where "${field}" is not a dimension - use ${dimensionHint()}`)
      }
      const values = Array.isArray(value) ? value : [value]
      if (!values.length || values.length > MAX_WHERE_VALUES) {
        throw new QueryError(`where "${field}" takes 1 to ${MAX_WHERE_VALUES} values`)
      }
      for (const item of values) {
        if (item !== null && typeof item !== 'string') {
          throw new QueryError(`where "${field}" takes a text, null, or a list of them`)
        }
      }
      where.push({ field, values: new Set(values.map((item) => (item === '' ? null : item))) })
    }
  }

  const groupBy = input.groupBy ?? []
  if (!Array.isArray(groupBy) || groupBy.length > 8) {
    throw new QueryError('groupBy is a list of up to 8 dimensions, like ["day", "page"]')
  }
  for (const field of groupBy) {
    if (!TIME_FIELDS.includes(field) && !isDimension(field)) {
      throw new QueryError(
        `groupBy "${field}" is not a dimension - use day, week, month, ${dimensionHint()}`,
      )
    }
  }
  if (new Set(groupBy).size !== groupBy.length) throw new QueryError('groupBy names a field twice')
  if (groupBy.filter((field) => TIME_FIELDS.includes(field)).length > 1) {
    throw new QueryError('groupBy takes one of day, week and month')
  }

  const measures = input.measures ?? ['records']
  if (
    !Array.isArray(measures) || !measures.length ||
    measures.some((measure) => !MEASURES.includes(measure))
  ) {
    throw new QueryError('measures is a list of records and visits, like ["records", "visits"]')
  }
  if (new Set(measures).size !== measures.length) throw new QueryError('measures names one twice')

  const limit = input.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new QueryError(`limit is a whole number from 1 to ${MAX_LIMIT}`)
  }
  return { app: input.app, from, to, where, groupBy, measures, limit }
}

const KEY_SEPARATOR = '\u0000'

const NULL_KEY = '\u0001'

const keyOf = (parts) => parts.map((part) => part ?? NULL_KEY).join(KEY_SEPARATOR)

const VISIT_BLIND_DIMENSIONS = ['zone', 'name']

export const canUseSummary = ({ where, groupBy, measures }) => {
  const fields = [...where.map((filter) => filter.field), ...groupBy]
  if (fields.includes('visit')) return false
  if (!measures.includes('visits')) return true
  return !fields.some((field) => VISIT_BLIND_DIMENSIONS.includes(field))
}

const groupParts = (groupBy, day) => ({
  fields: groupBy.filter((field) => !TIME_FIELDS.includes(field)),
  time: groupBy.map((field) => (TIME_FIELDS.includes(field) ? TIME_OF[field](day) : null)),
})

const createAggregate = () => {
  const groups = new Map()

  const group = (parts) => {
    const key = keyOf(parts)
    let found = groups.get(key)
    if (!found) {
      found = { key, parts, records: 0, visits: 0, stamp: 0 }
      groups.set(key, found)
    }
    return found
  }

  return {
    groups,
    group,
    stamp: 0,
    merge: (source) => {
      const target = group(source.parts)
      target.records += source.records
      target.visits += source.visits
    },
  }
}

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

export const finalizeQuery = (query, answers) => {
  const { app, from, to, groupBy, measures, limit } = query
  const aggregate = createAggregate()
  const days = new Set()
  const servers = []
  const skippedDays = []
  let scanned = 0
  let matched = 0
  for (const { server, answer } of answers) {
    for (const day of answer.days) days.add(day)
    for (const group of answer.groups) {
      aggregate.merge({ parts: group.by, records: group.records, visits: group.visits ?? 0 })
    }
    scanned += answer.scanned
    matched += answer.matched
    servers.push({
      server,
      days: answer.days.length,
      summaryDays: answer.summaryDays,
      scanned: answer.scanned,
      matched: answer.matched,
    })
    skippedDays.push(...answer.skippedDays.map((entry) => ({ server, ...entry })))
  }
  if (!groupBy.length && !aggregate.groups.size) aggregate.group([])

  const rows = [...aggregate.groups.values()].map((group) => {
    const row = {}
    groupBy.forEach((field, index) => {
      row[field] = group.parts[index]
    })
    for (const measure of measures) row[measure] = group[measure]
    return { row, key: group.key }
  })
  const [first] = measures
  rows.sort((a, b) => {
    const difference = b.row[first] - a.row[first]
    if (difference !== 0) return difference
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  return {
    app,
    from,
    to,
    days: days.size,
    scanned,
    matched,
    rows: rows.slice(0, limit).map((entry) => entry.row),
    truncated: rows.length > limit,
    servers,
    skippedDays,
  }
}
