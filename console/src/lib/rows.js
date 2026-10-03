import { daysBetween, shortDay } from './days.js'

export const NULL_LABEL = '(none)'

export const labelOf = (
  value,
) => (value === null || value === undefined ? NULL_LABEL : String(value))

export const sumOf = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0)

export const indexBy = (rows, key) => new Map(rows.map((row) => [labelOf(row[key]), row]))

export const pivot = (rows, { by, across, value }) => {
  const table = new Map()
  for (const row of rows) {
    const key = labelOf(row[by])
    const entry = table.get(key) ?? {}
    entry[labelOf(row[across])] = row[value]
    table.set(key, entry)
  }
  return table
}

export const dailySeries = (rows, { from, to, series }) => {
  const days = daysBetween(from, to)
  const byDay = new Map()
  for (const row of rows) {
    const list = byDay.get(row.day) ?? []
    list.push(row)
    byDay.set(row.day, list)
  }
  return {
    labels: days.map(shortDay),
    series: series.map(({ name, color, pick, empty = 0 }) => ({
      name,
      color,
      values: days.map((day) => {
        const list = byDay.get(day)
        return list ? pick(list) ?? empty : empty
      }),
    })),
  }
}

const seconds = (ms) => String(ms / 1000)

export const shareHistogram = (row, limits) => {
  const labels = []
  const values = []
  let previous = 0
  let lower = 0
  for (const limit of limits) {
    const share = row?.[`readyMs.under:${limit}`]
    if (share === null || share === undefined) return null
    labels.push(lower ? `${seconds(lower)}-${seconds(limit)} s` : `< ${seconds(limit)} s`)
    values.push(Math.round((share - previous) * 10) / 10)
    previous = share
    lower = limit
  }
  labels.push(`>= ${seconds(lower)} s`)
  values.push(Math.round((100 - previous) * 10) / 10)
  return { labels, values }
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
  if (groupBy[0] === 'day') {
    const days = [...new Set(rows.map((row) => row.day))].sort()
    if (groupBy.length === 1) {
      const byDay = indexBy(rows, 'day')
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
    const table = pivot(rows, { by: 'day', across: split, value: first })
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
