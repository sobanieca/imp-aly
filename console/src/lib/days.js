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
  { value: '30d', label: '30 days' },
  { value: '3m', label: '3 months' },
  { value: '6m', label: '6 months' },
  { value: '1y', label: '1 year' },
  { value: '5y', label: '5 years' },
]

const PRESET_MONTHS = { '3m': 3, '6m': 6, '1y': 12, '5y': 60 }

export const presetRange = (preset, now = Date.now()) => {
  const end = todayUtc(now)
  const months = PRESET_MONTHS[preset]
  return { start: months ? addDays(addMonths(end, -months), 1) : addDays(end, -29), end }
}

export const presetOf = (range, now = Date.now()) =>
  PRESETS.find(({ value }) => {
    const candidate = presetRange(value, now)
    return candidate.start === range?.start && candidate.end === range?.end
  })?.value

export const barOf = (from, to) => {
  const count = dayCount(from, to)
  if (count <= DAY_BARS_UP_TO) return 'day'
  return count <= WEEK_BARS_UP_TO ? 'week' : 'month'
}

export const previousRange = (from, to) => ({
  from: addDays(from, -dayCount(from, to)),
  to: addDays(from, -1),
})

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

export const barNote = (bar) =>
  `One bar is one ${bar} (UTC).${bar === 'week' ? ' A week starts on Monday.' : ''}`
