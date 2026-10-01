import { dayDir, listDays, readDay, readDaySummary } from './column-store.js'
import { forEachVisitLine, parseReady, tableLines } from './summary.js'
import { decodeValue } from './rle.js'
import { dayOf, isDay } from './days.js'
import { BASE_COLUMNS, isAppName, SEGMENT_NAME_PATTERN } from './names.js'

export class QueryError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

export const DEFAULT_LIMIT = 1_000

export const MAX_LIMIT = 100_000

const MAX_WHERE_VALUES = 1_000

const DIMENSIONS = BASE_COLUMNS.filter((column) => column !== 'at' && column !== 'readyMs')

const QUERY_KEYS = ['app', 'from', 'to', 'where', 'groupBy', 'measures', 'limit']

const READY_MEASURE = /^readyMs\.(avg|min|max|p([1-9]\d?))$/

const isDimension = (field) =>
  typeof field === 'string' &&
  (DIMENSIONS.includes(field) ||
    (SEGMENT_NAME_PATTERN.test(field) && !BASE_COLUMNS.includes(field) &&
      !['day', 'records', 'visits'].includes(field)))

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
    if (field !== 'day' && !isDimension(field)) {
      throw new QueryError(`groupBy "${field}" is not a dimension - use day, ${dimensionHint()}`)
    }
  }
  if (new Set(groupBy).size !== groupBy.length) throw new QueryError('groupBy names a field twice')

  const measures = input.measures ?? ['records']
  if (!Array.isArray(measures) || !measures.length || measures.length > 16) {
    throw new QueryError('measures is a list, like ["records", "visits", "readyMs.p75"]')
  }
  for (const measure of measures) {
    if (measure !== 'records' && measure !== 'visits' && !READY_MEASURE.test(measure)) {
      throw new QueryError(
        `measure "${measure}" is not known - use records, visits, readyMs.avg, readyMs.min, readyMs.max or readyMs.p1 to readyMs.p99`,
      )
    }
    if (groupBy.includes(measure)) throw new QueryError(`"${measure}" is a measure and a group`)
  }
  if (new Set(measures).size !== measures.length) throw new QueryError('measures names one twice')

  const limit = input.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new QueryError(`limit is a whole number from 1 to ${MAX_LIMIT}`)
  }
  return { app: input.app, from, to, where, groupBy, measures, limit }
}

const round = (value) => Math.round(value * 10) / 10

const valueAtRank = (entries, rank) => {
  let seen = 0
  for (const [value, count] of entries) {
    seen += count
    if (rank < seen) return value
  }
  return entries.at(-1)[0]
}

const readyValue = (measure, ready) => {
  const [, kind, percent] = READY_MEASURE.exec(measure)
  if (ready.size === 0) return null
  const entries = [...ready].sort((a, b) => a[0] - b[0])
  if (kind === 'min') return entries[0][0]
  if (kind === 'max') return entries.at(-1)[0]
  let total = 0
  let sum = 0
  for (const [value, count] of entries) {
    total += count
    sum += value * count
  }
  if (kind === 'avg') return round(sum / total)
  const position = (total - 1) * (Number(percent) / 100)
  const lower = valueAtRank(entries, Math.floor(position))
  const upper = valueAtRank(entries, Math.ceil(position))
  return round(lower + (upper - lower) * (position - Math.floor(position)))
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

const createAggregate = ({ groupBy, wantsReady }) => {
  const groups = new Map()

  const group = (parts) => {
    const key = keyOf(parts)
    let found = groups.get(key)
    if (!found) {
      found = { key, parts, records: 0, visits: 0, ready: new Map(), stamp: 0 }
      groups.set(key, found)
    }
    return found
  }

  return {
    groups,
    group,
    stamp: 0,
    addReady: (target, value, count) => {
      if (!wantsReady) return
      target.ready.set(value, (target.ready.get(value) ?? 0) + count)
    },
    ensureTotal: () => {
      if (!groupBy.length && !groups.size) group([])
    },
  }
}

const scanDay = async ({ path, day, query, aggregate, wantsVisits, wantsReady }) => {
  const { where, groupBy } = query
  const columns = new Set([
    ...where.map((filter) => filter.field),
    ...groupBy.filter((field) => field !== 'day'),
  ])
  if (wantsVisits) columns.add('visit')
  if (wantsReady) columns.add('readyMs')
  const { rows, columns: values } = await readDay(path, [...columns])
  const selected = new Uint8Array(rows).fill(1)
  for (const filter of where) {
    const column = values[filter.field]
    for (let row = 0; row < rows; row++) {
      if (selected[row] && !filter.values.has(column[row])) selected[row] = 0
    }
  }
  const groupColumns = groupBy.map((field) => (field === 'day' ? null : values[field]))
  const dayVisits = new Map()
  let matched = 0
  for (let row = 0; row < rows; row++) {
    if (!selected[row]) continue
    matched++
    const target = aggregate.group(
      groupColumns.map((column) => (column === null ? day : column[row])),
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
    if (wantsReady && values.readyMs[row] !== null) {
      aggregate.addReady(target, Number(values.readyMs[row]), 1)
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

const summaryDay = ({ summary, day, query, aggregate, wantsVisits, wantsReady }) => {
  const { where, groupBy } = query
  const groupFields = groupBy.filter((field) => field !== 'day')
  const needed = [...where.map((filter) => filter.field), ...groupFields]
  const select = (cells, read) => {
    const values = read(cells)
    for (let index = 0; index < where.length; index++) {
      if (!where[index].values.has(values[index])) return null
    }
    let next = where.length
    return aggregate.group(groupBy.map((field) => (field === 'day' ? day : values[next++])))
  }

  const counts = tableLines(summary.counts)
  const readCounts = cellsOf(counts.header, needed)
  const recordsAt = counts.header.length - 2
  let matched = 0
  for (const line of counts.lines) {
    const cells = wantsReady ? line.split('\t') : line.split('\t', recordsAt + 1)
    const target = select(cells, readCounts)
    if (!target) continue
    const records = Number(cells[recordsAt])
    matched += records
    target.records += records
    if (wantsReady) {
      for (const [value, count] of parseReady(cells[recordsAt + 1])) {
        aggregate.addReady(target, value, count)
      }
    }
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
  const { app, from, to, groupBy, measures, limit } = query
  const wantsVisits = measures.includes('visits')
  const wantsReady = measures.some((measure) => measure.startsWith('readyMs.'))
  const useSummary = canUseSummary(query)
  const aggregate = createAggregate({ groupBy, wantsReady })

  const days = (await listDays(dataDir, app)).filter((day) => day >= from && day <= to)
  let scanned = 0
  let matched = 0
  let summaryDays = 0
  for (const day of days) {
    const path = dayDir(dataDir, app, day)
    const summary = useSummary ? await readDaySummary(path, { withVisits: wantsVisits }) : null
    const result = summary
      ? summaryDay({ summary, day, query, aggregate, wantsVisits, wantsReady })
      : await scanDay({ path, day, query, aggregate, wantsVisits, wantsReady })
    if (summary) summaryDays++
    scanned += result.scanned
    matched += result.matched
  }
  aggregate.ensureTotal()

  const rows = [...aggregate.groups.values()].map((group) => {
    const row = {}
    groupBy.forEach((field, index) => {
      row[field] = group.parts[index]
    })
    for (const measure of measures) {
      if (measure === 'records') row.records = group.records
      else if (measure === 'visits') row.visits = group.visits
      else row[measure] = readyValue(measure, group.ready)
    }
    return { row, key: group.key }
  })
  const [first] = measures
  rows.sort((a, b) => {
    const difference = (b.row[first] ?? -Infinity) - (a.row[first] ?? -Infinity)
    if (difference !== 0 && !Number.isNaN(difference)) return difference
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  return {
    app,
    from,
    to,
    days: days.length,
    summaryDays,
    scanned,
    matched,
    rows: rows.slice(0, limit).map((entry) => entry.row),
    truncated: rows.length > limit,
  }
}
