export const encodeValue = (value) => (value === null || value === undefined ? '' : String(value))

export const decodeValue = (text) => (text === '' ? null : text)

export const splitLines = (text) => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) !== '') throw new Error('a column file does not end with a line break')
  lines.pop()
  return lines.map(decodeValue)
}

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
