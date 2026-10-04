import { TIME_FIELDS } from './measures.js'

export const NULL_LABEL = '(none)'

export const labelOf = (
  value,
) => (value === null || value === undefined ? NULL_LABEL : String(value))

export const indexBy = (rows, key) => new Map(rows.map((row) => [labelOf(row[key]), row]))

const pivot = (rows, { by, across, value }) => {
  const table = new Map()
  for (const row of rows) {
    const key = labelOf(row[by])
    const entry = table.get(key) ?? {}
    entry[labelOf(row[across])] = row[value]
    table.set(key, entry)
  }
  return table
}

const csvCell = (value) => {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export const toCsv = (columns, rows) =>
  [columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((line) => line.map(csvCell).join(','))
    .join('\n') + '\n'

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`

export const cliCommand = (query, servers = []) =>
  `imp-aly query ${shellQuote(JSON.stringify(query))}${
    servers.length ? ` -s ${servers.join(',')}` : ''
  }`

export const resultChart = ({ rows, groupBy, measures }, { maxBars = 20 } = {}) => {
  if (!rows.length || !measures.length) return null
  const [first] = measures
  const [time] = groupBy
  if (TIME_FIELDS.includes(time)) {
    const days = [...new Set(rows.map((row) => row[time]))].sort()
    if (groupBy.length === 1) {
      const byDay = indexBy(rows, time)
      return {
        type: 'line',
        measure: first,
        labels: days,
        series: measures.slice(0, 1).map((measure) => ({
          name: measure,
          values: days.map((day) => byDay.get(day)?.[measure] ?? null),
        })),
      }
    }
    const split = groupBy[1]
    const totals = new Map()
    for (const row of rows) {
      const key = labelOf(row[split])
      totals.set(key, (totals.get(key) ?? 0) + (row[first] ?? 0))
    }
    const top = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key]) => key)
    const table = pivot(rows, { by: time, across: split, value: first })
    return {
      type: 'line',
      measure: first,
      labels: days,
      series: top.map((key) => ({
        name: key,
        values: days.map((day) => table.get(day)?.[key] ?? null),
      })),
    }
  }
  const shown = rows.slice(0, maxBars)
  return {
    type: 'bar',
    measure: first,
    labels: shown.map((row) => groupBy.map((field) => labelOf(row[field])).join(' / ') || 'All'),
    series: [{ name: first, values: shown.map((row) => row[first]) }],
  }
}
