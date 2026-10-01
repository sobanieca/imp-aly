import { dayDir, listDays, readDay } from './column-store.js'
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

const MAX_DISTINCT_VISITS = 10_000_000

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

const percentile = (sorted, fraction) => {
  if (!sorted.length) return null
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
  return Math.round(value * 10) / 10
}

const readyValue = (measure, values) => {
  const [, kind, percent] = READY_MEASURE.exec(measure)
  if (!values.length) return null
  if (kind === 'min') return values[0]
  if (kind === 'max') return values.at(-1)
  if (kind === 'avg') {
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10
  }
  return percentile(values, Number(percent) / 100)
}

const KEY_SEPARATOR = '\u0000'

const NULL_KEY = '\u0001'

export const runQuery = async ({ dataDir, query }) => {
  const { app, from, to, where, groupBy, measures, limit } = query
  const wantsVisits = measures.includes('visits')
  const wantsReady = measures.some((measure) => measure.startsWith('readyMs.'))
  const columns = new Set([
    ...where.map((filter) => filter.field),
    ...groupBy.filter((field) => field !== 'day'),
  ])
  if (wantsVisits) columns.add('visit')
  if (wantsReady) columns.add('readyMs')

  const days = (await listDays(dataDir, app)).filter((day) => day >= from && day <= to)
  const groups = new Map()
  let scanned = 0
  let matched = 0
  let distinctVisits = 0

  for (const day of days) {
    const { rows, columns: values } = await readDay(dayDir(dataDir, app, day), [...columns])
    scanned += rows
    const selected = new Uint8Array(rows).fill(1)
    for (const filter of where) {
      const column = values[filter.field]
      for (let row = 0; row < rows; row++) {
        if (selected[row] && !filter.values.has(column[row])) selected[row] = 0
      }
    }
    const groupColumns = groupBy.map((field) => (field === 'day' ? null : values[field]))
    for (let row = 0; row < rows; row++) {
      if (!selected[row]) continue
      matched++
      const parts = groupColumns.map((column) => (column === null ? day : column[row]))
      const key = parts.map((part) => part ?? NULL_KEY).join(KEY_SEPARATOR)
      let group = groups.get(key)
      if (!group) {
        group = { key, parts, records: 0, visits: wantsVisits ? new Set() : null, ready: [] }
        groups.set(key, group)
      }
      group.records++
      if (wantsVisits) {
        const visit = values.visit[row]
        if (visit !== null && !group.visits.has(visit)) {
          group.visits.add(visit)
          distinctVisits++
          if (distinctVisits > MAX_DISTINCT_VISITS) {
            throw new QueryError(
              'the query counts more than 10000000 distinct visits - use a shorter range or fewer groups',
            )
          }
        }
      }
      if (wantsReady) {
        const ready = values.readyMs[row]
        if (ready !== null) group.ready.push(Number(ready))
      }
    }
  }

  if (!groupBy.length && !groups.size) {
    groups.set('', { key: '', parts: [], records: 0, visits: new Set(), ready: [] })
  }
  const rows = [...groups.values()].map((group) => {
    const row = {}
    groupBy.forEach((field, index) => {
      row[field] = group.parts[index]
    })
    if (wantsReady) group.ready.sort((a, b) => a - b)
    for (const measure of measures) {
      if (measure === 'records') row.records = group.records
      else if (measure === 'visits') row.visits = group.visits.size
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
    scanned,
    matched,
    rows: rows.slice(0, limit).map((entry) => entry.row),
    truncated: rows.length > limit,
  }
}
