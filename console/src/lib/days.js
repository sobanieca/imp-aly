const DAY_MS = 86_400_000

const DAY_BARS_UP_TO = 45

const WEEK_BARS_UP_TO = 200

export const todayUtc = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

export const addDays = (day, count) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10)

export const addMonths = (day, count) => {
  const date = new Date(`${day}T00:00:00Z`)
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0))
  first.setUTCDate(Math.min(date.getUTCDate(), last.getUTCDate()))
  return first.toISOString().slice(0, 10)
}

export const dayCount = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1

export const PRESETS = [
  { value: '7d', label: 'Last 7 days', days: 7, before: '-14 to -7 days' },
  { value: '30d', label: 'Last 30 days', days: 30, before: '-60 to -30 days' },
  { value: '3m', label: 'Last 3 months', months: 3, before: '-6 to -3 months' },
  { value: '6m', label: 'Last 6 months', months: 6, before: '-12 to -6 months' },
  { value: '1y', label: 'Last year', months: 12, before: '-2 to -1 years' },
  { value: '5y', label: 'Last 5 years', months: 60, before: '-10 to -5 years' },
]

export const DEFAULT_PRESET = '30d'

const presetEntry = (preset) => PRESETS.find(({ value }) => value === preset)

export const isPreset = (preset) => presetEntry(preset) !== undefined

const backFrom = (end, entry, count) =>
  entry.months
    ? addDays(addMonths(end, -entry.months * count), 1)
    : addDays(end, 1 - entry.days * count)

export const presetRange = (preset, now = Date.now()) => {
  const end = todayUtc(now)
  return { start: backFrom(end, presetEntry(preset), 1), end }
}

export const presetPrevious = (preset, now = Date.now()) => {
  const entry = presetEntry(preset)
  const end = todayUtc(now)
  return { from: backFrom(end, entry, 2), to: addDays(backFrom(end, entry, 1), -1) }
}

export const previousLabel = (preset) => presetEntry(preset)?.before ?? null

export const barOf = (from, to) => {
  const count = dayCount(from, to)
  if (count <= DAY_BARS_UP_TO) return 'day'
  return count <= WEEK_BARS_UP_TO ? 'week' : 'month'
}

export const mondayOf = (day) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))

const bucketOf = (day, bar) => {
  if (bar === 'month') return day.slice(0, 7)
  return bar === 'week' ? mondayOf(day) : day
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
