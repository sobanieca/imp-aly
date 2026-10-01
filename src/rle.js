export const encodeValue = (value) => (value === null || value === undefined ? '' : String(value))

export const decodeValue = (text) => (text === '' ? null : text)

export const splitLines = (text) => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) !== '') throw new Error('a column file does not end with a line break')
  lines.pop()
  return lines.map(decodeValue)
}

export const countRuns = (values, order) => {
  let runs = 0
  for (let position = 0; position < order.length; position++) {
    if (position === 0 || values[order[position]] !== values[order[position - 1]]) runs++
  }
  return runs
}

export function* runLines(values, order) {
  let current = null
  let count = 0
  for (let position = 0; position < order.length; position++) {
    const value = values[order[position]]
    if (count > 0 && value === current) {
      count++
      continue
    }
    if (count > 0) yield `${count}\t${encodeValue(current)}\n`
    current = value
    count = 1
  }
  if (count > 0) yield `${count}\t${encodeValue(current)}\n`
}

export function* plainLines(values, order) {
  for (let position = 0; position < order.length; position++) {
    yield `${encodeValue(values[order[position]])}\n`
  }
}

export const encodeRuns = (values, order) => [...runLines(values, order)].join('')

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
