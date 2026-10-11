import { addDays, addMonths, dayCount, dayOf, weekOf } from '../shared/days.js'

const DAY_BARS_UP_TO = 45

const WEEK_BARS_UP_TO = 200

export const todayUtc = (now = Date.now()) => dayOf(now)

export const PRESETS = [
  { value: '7d', label: 'Last 7 days', days: 7, before: 'Previous 7 days' },
  { value: '30d', label: 'Last 30 days', days: 30, before: 'Previous 30 days' },
  { value: '3m', label: 'Last 3 months', months: 3, before: 'Previous 3 months' },
  { value: '6m', label: 'Last 6 months', months: 6, before: 'Previous 6 months' },
  { value: '1y', label: 'Last year', months: 12, before: 'Previous year' },
  { value: '5y', label: 'Last 5 years', months: 60, before: 'Previous 5 years' },
]

export const DEFAULT_PRESET = '30d'

const presetEntry = (preset) => PRESETS.find(({ value }) => value === preset)

export const isPreset = (preset) => presetEntry(preset) !== undefined

const backFrom = (end, entry, count) =>
  entry.months
    ? addDays(addMonths(end, -entry.months * count), 1)
    : addDays(end, 1 - entry.days * count)

export const presetRange = (preset, today = todayUtc()) => ({
  start: backFrom(today, presetEntry(preset), 1),
  end: today,
})

export const presetPrevious = (preset, today = todayUtc()) => {
  const entry = presetEntry(preset)
  return { from: backFrom(today, entry, 2), to: addDays(backFrom(today, entry, 1), -1) }
}

export const previousLabel = (preset) => presetEntry(preset)?.before ?? null

export const barOf = (from, to) => {
  const count = dayCount(from, to)
  if (count <= DAY_BARS_UP_TO) return 'day'
  return count <= WEEK_BARS_UP_TO ? 'week' : 'month'
}

const bucketOf = (day, bar) => {
  if (bar === 'month') return day.slice(0, 7)
  return bar === 'week' ? weekOf(day) : day
}

export const bucketsOf = (from, to, bar) => {
  const buckets = []
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const bucket = bucketOf(day, bar)
    if (buckets.at(-1) !== bucket) buckets.push(bucket)
  }
  return buckets
}

export const bucketLabel = (bucket, bar) => (bar === 'day' ? bucket.slice(5) : bucket)
