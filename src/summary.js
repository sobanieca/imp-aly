import { BASE_COLUMNS } from './names.js'
import { encodeValue } from './rle.js'

export const SUMMARY_FILES = {
  counts: 'summary-counts.tsv',
  tuples: 'summary-tuples.tsv',
  visits: 'summary-visits.tsv',
}

export const COUNT_DIMENSIONS = ['type', 'page', 'zone', 'name', 'country']

export const VISIT_DIMENSIONS = ['type', 'page', 'country']

const segmentsOf = (columns) => columns.filter((column) => !BASE_COLUMNS.includes(column)).sort()

const encodeReady = (ready) =>
  ready === null
    ? ''
    : [...ready].sort((a, b) => a[0] - b[0]).map(([value, count]) => `${value}:${count}`).join(',')

export const buildSummary = ({ columns, rows, column }) => {
  const segments = segmentsOf(columns)
  const countDimensions = [...COUNT_DIMENSIONS, ...segments]
  const visitDimensions = [...VISIT_DIMENSIONS, ...segments]
  const encoded = {}
  for (const dimension of countDimensions) encoded[dimension] = column(dimension)

  const counts = new Map()
  const ready = column('readyMs')
  const readyNumbers = ready.values.map((value) => (value === null ? null : Number(value)))
  for (let row = 0; row < rows; row++) {
    const key = countDimensions.map((dimension) => encoded[dimension].ids[row]).join(',')
    let entry = counts.get(key)
    if (!entry) {
      entry = { row, records: 0, ready: null }
      counts.set(key, entry)
    }
    entry.records++
    const value = readyNumbers[ready.ids[row]]
    if (value !== null) {
      entry.ready ??= new Map()
      entry.ready.set(value, (entry.ready.get(value) ?? 0) + 1)
    }
  }

  const tuples = new Map()
  const tupleRows = []
  const visitTuples = new Map()
  const visits = column('visit')
  for (let row = 0; row < rows; row++) {
    const key = visitDimensions.map((dimension) => encoded[dimension].ids[row]).join(',')
    let index = tuples.get(key)
    if (index === undefined) {
      index = tuples.size
      tuples.set(key, index)
      tupleRows.push(row)
    }
    const visit = visits.ids[row]
    if (visits.values[visit] === null) continue
    let set = visitTuples.get(visit)
    if (!set) {
      set = new Set()
      visitTuples.set(visit, set)
    }
    set.add(index)
  }

  const valueOf = (dimension, row) =>
    encodeValue(encoded[dimension].values[encoded[dimension].ids[row]])
  const countLines = [`${[...countDimensions, 'records', 'readyMs'].join('\t')}\n`]
  for (const entry of counts.values()) {
    const values = countDimensions.map((dimension) => valueOf(dimension, entry.row))
    countLines.push(`${[...values, entry.records, encodeReady(entry.ready)].join('\t')}\n`)
  }
  const tupleLines = [`${visitDimensions.join('\t')}\n`]
  for (const row of tupleRows) {
    tupleLines.push(`${visitDimensions.map((dimension) => valueOf(dimension, row)).join('\t')}\n`)
  }
  const visitCounts = new Map()
  for (const set of visitTuples.values()) {
    const key = [...set].sort((a, b) => a - b).join(',')
    visitCounts.set(key, (visitCounts.get(key) ?? 0) + 1)
  }
  const visitLines = ['visits\ttuples\n']
  for (const [key, count] of visitCounts) visitLines.push(`${count}\t${key}\n`)
  return { counts: countLines, tuples: tupleLines, visits: visitLines }
}

export const tableLines = (text) => {
  const lines = text.split('\n')
  if (lines.at(-1) !== '') throw new Error('a summary file does not end with a line break')
  lines.pop()
  if (!lines.length) throw new Error('a summary file has no header')
  return { header: lines[0].split('\t'), lines: lines.slice(1) }
}

export const parseReady = (text) => {
  const ready = []
  if (text === '') return ready
  for (const pair of text.split(',')) {
    const colon = pair.indexOf(':')
    ready.push([Number(pair.slice(0, colon)), Number(pair.slice(colon + 1))])
  }
  return ready
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
