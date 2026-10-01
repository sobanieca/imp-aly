export const encodeValue = (value) => (value === null || value === undefined ? '' : String(value))

export const decodeValue = (text) => (text === '' ? null : text)

export const splitLines = (text) => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) !== '') throw new Error('a column file does not end with a line break')
  lines.pop()
  return lines.map(decodeValue)
}

const compareText = (a, b) => {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}

export const compareNumeric = (a, b) => {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return Number(a) - Number(b)
}

export const dictionaryEncode = (values, compare = compareText) => {
  const dictionary = [...new Set(values)].sort(compare)
  const idOf = new Map(dictionary.map((value, index) => [value, index]))
  const ids = new Uint32Array(values.length)
  for (let row = 0; row < values.length; row++) ids[row] = idOf.get(values[row])
  return { ids, values: dictionary }
}

export const countRuns = ({ ids }, order) => {
  let runs = 0
  for (let position = 0; position < order.length; position++) {
    if (position === 0 || ids[order[position]] !== ids[order[position - 1]]) runs++
  }
  return runs
}

export function* runLines({ ids, values }, order) {
  let current = 0
  let count = 0
  for (let position = 0; position < order.length; position++) {
    const id = ids[order[position]]
    if (count > 0 && id === current) {
      count++
      continue
    }
    if (count > 0) yield `${count}\t${encodeValue(values[current])}\n`
    current = id
    count = 1
  }
  if (count > 0) yield `${count}\t${encodeValue(values[current])}\n`
}

export function* plainLines({ ids, values }, order) {
  for (let position = 0; position < order.length; position++) {
    yield `${encodeValue(values[ids[order[position]]])}\n`
  }
}

export const encodeRuns = (values, order) => [...runLines(dictionaryEncode(values), order)].join('')

export const decodeRuns = (text, rows) => {
  const values = new Array(rows)
  let filled = 0
  let start = 0
  while (start < text.length) {
    const end = text.indexOf('\n', start)
    if (end === -1) throw new Error('a run file does not end with a line break')
    const tab = text.indexOf('\t', start)
    if (tab === -1 || tab > end) throw new Error('a run line has no tab')
    const count = Number(text.slice(start, tab))
    if (!Number.isSafeInteger(count) || count < 1 || filled + count > rows) {
      throw new Error('a run line has a wrong count')
    }
    values.fill(decodeValue(text.slice(tab + 1, end)), filled, filled + count)
    filled += count
    start = end + 1
  }
  if (filled !== rows) throw new Error(`a run file holds ${filled} rows, expected ${rows}`)
  return values
}
