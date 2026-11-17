import { labelOf } from './rows.js'

export const TOP = 10

export const OTHER = 'Other'

// The most series of a chart of every key. Above it, the keys with the fewest records are "Other",
// so a chart stays readable and fast for an app with hundreds of pages.
export const MAX_SERIES = 50

const COLORS = [
  'blue',
  'orange',
  'pink',
  'cyan',
  'purple',
  'green',
  'indigo',
  'red',
  'teal',
  'brown',
]

export const totalsBy = (rows, field, value = 'records') => {
  const totals = new Map()
  for (const row of rows) {
    const key = labelOf(row[field])
    totals.set(key, (totals.get(key) ?? 0) + (row[value] ?? 0))
  }
  return totals
}

export const topKeys = (rows, field, { value = 'records', count = TOP } = {}) =>
  [...totalsBy(rows, field, value)]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, count)
    .map(([key]) => key)

// Every key with records, the most records first, up to MAX_SERIES
export const everyKey = (rows, field) => topKeys(rows, field, { count: MAX_SERIES })

export const stackedSeries = (
  rows,
  { bar, field, buckets, keys, value = 'records', other = true },
) => {
  const position = new Map(buckets.map((bucket, index) => [bucket, index]))
  const series = keys.map((key, index) => ({
    name: key,
    color: COLORS[index % COLORS.length],
    values: buckets.map(() => 0),
  }))
  const byKey = new Map(series.map((entry) => [entry.name, entry]))
  const rest = buckets.map(() => 0)
  let hasRest = false
  for (const row of rows) {
    const index = position.get(row[bar])
    if (index === undefined) continue
    const amount = row[value] ?? 0
    const target = byKey.get(labelOf(row[field]))
    if (target) target.values[index] += amount
    else if (other && amount) {
      rest[index] += amount
      hasRest = true
    }
  }
  return hasRest ? [...series, { name: OTHER, color: 'gray', values: rest }] : series
}

export const usedSeries = (rows, { bar, buckets, shownType, shownLabel }) => {
  const position = new Map(buckets.map((bucket, index) => [bucket, index]))
  const used = buckets.map(() => 0)
  const shown = buckets.map(() => 0)
  for (const row of rows) {
    const index = position.get(row[bar])
    if (index === undefined) continue
    if (row.type === 'used') used[index] += row.records ?? 0
    if (row.type === shownType) shown[index] += row.records ?? 0
  }
  return [
    { name: 'Used', color: 'blue', values: used },
    {
      name: shownLabel,
      color: 'gray',
      values: shown.map((count, index) => Math.max(count - used[index], 0)),
    },
  ]
}
