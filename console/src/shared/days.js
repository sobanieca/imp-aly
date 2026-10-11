const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const DAY_MS = 86_400_000

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

export const isDay = (value) => {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false
  const ms = Date.parse(value)
  return Number.isFinite(ms) && dayOf(ms) === value
}

export const weekOf = (day) => {
  const time = Date.parse(day)
  const weekday = (new Date(time).getUTCDay() + 6) % 7
  return dayOf(time - weekday * DAY_MS)
}

export const addDays = (day, count) => dayOf(Date.parse(day) + count * DAY_MS)

export const addMonths = (day, count) => {
  const date = new Date(Date.parse(day))
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0))
  first.setUTCDate(Math.min(date.getUTCDate(), last.getUTCDate()))
  return dayOf(first.getTime())
}

export const dayCount = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1
