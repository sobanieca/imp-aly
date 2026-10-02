import { BASE_COLUMNS, MAX_SEGMENTS, RESERVED_NAMES, SEGMENT_NAME_PATTERN } from './names.js'
import { isCountry, isName, isSegmentValue, TYPE_FIELDS } from './records.js'
import {
  addReadyValue,
  bucketOf,
  createReady,
  isBucket,
  MAX_READY_MS,
  sortedBuckets,
} from './ready.js'

export const SUMMARY_FILES = {
  counts: 'summary-counts.tsv',
  tuples: 'summary-tuples.tsv',
  visits: 'summary-visits.tsv',
}

export const COUNT_DIMENSIONS = ['type', 'page', 'zone', 'name', 'country']

export const VISIT_DIMENSIONS = ['type', 'page', 'country']

export const COUNT_MEASURES = ['records', 'readySum', 'readyMin', 'readyMax', 'readyMs']

const segmentsOf = (columns) => columns.filter((column) => !BASE_COLUMNS.includes(column)).sort()

const readyCells = (ready) =>
  ready === null ? ['', '', '', ''] : [
    ready.sum,
    ready.min,
    ready.max,
    sortedBuckets(ready).map(([bucket, count]) => `${bucket}:${count}`).join(','),
  ]

export const createSummaryBuilder = ({ columns, rowColumns }) => {
  const segments = segmentsOf(columns)
  const countDimensions = [...COUNT_DIMENSIONS, ...segments]
  const visitDimensions = [...VISIT_DIMENSIONS, ...segments]
  const positionsOf = (dimensions) => dimensions.map((dimension) => rowColumns.indexOf(dimension))
  const countPositions = positionsOf(countDimensions)
  const visitPositions = positionsOf(visitDimensions)
  const readyPosition = rowColumns.indexOf('readyMs')
  const visitPosition = rowColumns.indexOf('visit')
  const keyOf = (columns, row, positions) => {
    let key = ''
    for (let index = 0; index < positions.length; index++) {
      const position = positions[index]
      if (index > 0) key += '\t'
      if (position !== -1) key += columns[position][row] ?? ''
    }
    return key
  }
  const valueAt = (columns, row, position) => (position === -1 ? null : columns[position][row])

  const counts = new Map()
  const tuples = new Map()
  const visitTuples = new Map()

  const add = (columns, row) => {
    const countKey = keyOf(columns, row, countPositions)
    let entry = counts.get(countKey)
    if (!entry) {
      entry = { records: 0, ready: null }
      counts.set(countKey, entry)
    }
    entry.records++
    const ready = valueAt(columns, row, readyPosition)
    if (ready !== null) {
      entry.ready ??= createReady()
      addReadyValue(entry.ready, Number(ready))
    }

    const tupleKey = keyOf(columns, row, visitPositions)
    let index = tuples.get(tupleKey)
    if (index === undefined) {
      index = tuples.size
      tuples.set(tupleKey, index)
    }
    const visit = valueAt(columns, row, visitPosition)
    if (visit === null) return
    let set = visitTuples.get(visit)
    if (!set) {
      set = new Set()
      visitTuples.set(visit, set)
    }
    set.add(index)
  }

  return {
    addRows: (columns, count) => {
      for (let row = 0; row < count; row++) add(columns, row)
    },
    finish: () => {
      const countLines = [`${[...countDimensions, ...COUNT_MEASURES].join('\t')}\n`]
      for (const [key, entry] of counts) {
        countLines.push(`${[key, entry.records, ...readyCells(entry.ready)].join('\t')}\n`)
      }
      const tupleLines = [`${visitDimensions.join('\t')}\n`]
      for (const key of tuples.keys()) tupleLines.push(`${key}\n`)
      const visitCounts = new Map()
      for (const set of visitTuples.values()) {
        const key = [...set].sort((a, b) => a - b).join(',')
        visitCounts.set(key, (visitCounts.get(key) ?? 0) + 1)
      }
      const visitLines = ['visits\ttuples\n']
      for (const [key, count] of visitCounts) visitLines.push(`${count}\t${key}\n`)
      return { counts: countLines, tuples: tupleLines, visits: visitLines }
    },
  }
}

export const tableLines = (text) => {
  const lines = text.split('\n')
  if (lines.at(-1) !== '') throw new Error('a summary file does not end with a line break')
  lines.pop()
  if (!lines.length) throw new Error('a summary file has no header')
  return { header: lines[0].split('\t'), lines: lines.slice(1) }
}

const parseBuckets = (text) => {
  const buckets = []
  for (const pair of text.split(',')) {
    const colon = pair.indexOf(':')
    buckets.push([Number(pair.slice(0, colon)), Number(pair.slice(colon + 1))])
  }
  return buckets
}

export const parseReadyCells = ([sum, min, max, text]) => {
  if (text === '') return null
  const buckets = parseBuckets(text)
  const count = buckets.reduce((total, [, bucketCount]) => total + bucketCount, 0)
  return { count, sum: Number(sum), min: Number(min), max: Number(max), buckets }
}

const TAB = 9

const NEWLINE = 10

const COMMA = 44

const ZERO = 48

export const forEachVisitLine = (text, onLine) => {
  const tuples = []
  let position = text.indexOf('\n') + 1
  while (position < text.length) {
    let visits = 0
    let code = text.charCodeAt(position)
    while (code !== TAB) {
      if (code < ZERO || code > ZERO + 9) throw new Error('a summary visit line is not valid')
      visits = visits * 10 + code - ZERO
      code = text.charCodeAt(++position)
    }
    tuples.length = 0
    let index = 0
    code = text.charCodeAt(++position)
    while (true) {
      if (code === COMMA || code === NEWLINE) {
        tuples.push(index)
        index = 0
        if (code === NEWLINE) break
      } else if (code >= ZERO && code <= ZERO + 9) {
        index = index * 10 + code - ZERO
      } else {
        throw new Error('a summary visit line is not valid')
      }
      code = text.charCodeAt(++position)
    }
    onLine(visits, tuples)
    position++
  }
}

const hasControlCharacter = (text) => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if ((code < 0x20 && code !== TAB && code !== NEWLINE) || code === 0x7f) return true
  }
  return false
}

const POSITIVE = /^[1-9]\d*$/

const NUMBER = /^(0|[1-9]\d*)$/

const READY_TEXT = /^\d+:[1-9]\d*(,\d+:[1-9]\d*)*$/

const VISIT_LINE = /^[1-9]\d*\t\d+(,\d+)*$/

const optional = (check) => (value) => value === '' || check(value)

const CELL_CHECKS = {
  type: (value) => Object.hasOwn(TYPE_FIELDS, value),
  page: (value) => value !== '',
  zone: optional(isName),
  name: optional(isName),
  country: optional(isCountry),
}

const isSegmentCell = optional(isSegmentValue)

const validCells = (dimensions, cells) =>
  cells.length >= dimensions.length &&
  dimensions.every((dimension, index) => (CELL_CHECKS[dimension] ?? isSegmentCell)(cells[index]))

const validReady = (cells, records) => {
  const [sum, min, max, text] = cells
  if (text === '') return cells.every((cell) => cell === '')
  if (![sum, min, max].every((cell) => NUMBER.test(cell)) || !READY_TEXT.test(text)) return false
  const ready = parseReadyCells(cells)
  const buckets = ready.buckets.map(([bucket]) => bucket)
  return buckets.every((bucket, index) =>
    isBucket(bucket) && (index === 0 || bucket > buckets[index - 1])
  ) &&
    ready.count <= records && ready.max <= MAX_READY_MS && Number.isSafeInteger(ready.sum) &&
    bucketOf(ready.min) === buckets[0] &&
    bucketOf(ready.max) === buckets.at(-1) && ready.sum >= ready.min * ready.count &&
    ready.sum <= ready.max * ready.count
}

const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index])

const checkSegments = (segments) => {
  if (segments.length > MAX_SEGMENTS) throw new Error('the summary has too many segments')
  segments.forEach((segment, index) => {
    if (!SEGMENT_NAME_PATTERN.test(segment) || RESERVED_NAMES.has(segment)) {
      throw new Error(`the summary has a segment "${segment}" that is not valid`)
    }
    if (index > 0 && segments[index - 1] >= segment) {
      throw new Error('the summary segments are not sorted')
    }
  })
}

export const checkSummary = ({ counts, tuples, visits }) => {
  for (const text of [counts, tuples, visits]) {
    if (hasControlCharacter(text)) throw new Error('a summary file holds a control character')
  }
  const countTable = tableLines(counts)
  const segments = countTable.header.slice(COUNT_DIMENSIONS.length, -COUNT_MEASURES.length)
  checkSegments(segments)
  const countDimensions = [...COUNT_DIMENSIONS, ...segments]
  const countHeader = [...countDimensions, ...COUNT_MEASURES]
  if (!sameList(countTable.header, countHeader)) {
    throw new Error(`${SUMMARY_FILES.counts} has a header that is not valid`)
  }
  let rows = 0
  for (const line of countTable.lines) {
    const cells = line.split('\t')
    const records = cells[countDimensions.length]
    if (
      cells.length !== countHeader.length || !validCells(countDimensions, cells) ||
      !POSITIVE.test(records) || !validReady(cells.slice(-4), Number(records))
    ) {
      throw new Error(`${SUMMARY_FILES.counts} has a line that is not valid`)
    }
    rows += Number(records)
  }
  if (!Number.isSafeInteger(rows)) {
    throw new Error(`${SUMMARY_FILES.counts} counts too many records`)
  }

  const tupleTable = tableLines(tuples)
  const tupleHeader = [...VISIT_DIMENSIONS, ...segments]
  if (!sameList(tupleTable.header, tupleHeader)) {
    throw new Error(`${SUMMARY_FILES.tuples} has a header that is not valid`)
  }
  for (const line of tupleTable.lines) {
    const cells = line.split('\t')
    if (cells.length !== tupleHeader.length || !validCells(tupleHeader, cells)) {
      throw new Error(`${SUMMARY_FILES.tuples} has a line that is not valid`)
    }
  }

  const visitTable = tableLines(visits)
  if (!sameList(visitTable.header, ['visits', 'tuples'])) {
    throw new Error(`${SUMMARY_FILES.visits} has a header that is not valid`)
  }
  for (const line of visitTable.lines) {
    if (
      !VISIT_LINE.test(line) ||
      line.split('\t')[1].split(',').some((index) => Number(index) >= tupleTable.lines.length)
    ) {
      throw new Error(`${SUMMARY_FILES.visits} has a line that is not valid`)
    }
  }
  return rows
}
