import { dayOf, isDay } from './days.js'
import { BASE_COLUMNS, isAppName, RESERVED_NAMES, SEGMENT_NAME_PATTERN } from './names.js'

class QueryError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

const DEFAULT_LIMIT = 1_000

const MAX_LIMIT = 100_000

const MAX_WHERE_VALUES = 1_000

const DIMENSIONS = BASE_COLUMNS.filter((column) => column !== 'at')

const TIME_FIELDS = ['day', 'week', 'month']

const MEASURES = ['records', 'visits']

const QUERY_KEYS = ['app', 'from', 'to', 'where', 'groupBy', 'measures', 'limit']

const isDimension = (field) =>
  typeof field === 'string'
  && (DIMENSIONS.includes(field)
    || (SEGMENT_NAME_PATTERN.test(field) && !RESERVED_NAMES.has(field)))

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
    !Array.isArray(measures)
    || !measures.length
    || measures.some((measure) => !MEASURES.includes(measure))
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
