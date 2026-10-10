export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const MONTH_PATTERN = /^\d{4}-\d{2}$/

export const DAY_MS = 86_400_000

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

export const isDay = (value) => {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false
  const ms = Date.parse(value)
  return Number.isFinite(ms) && dayOf(ms) === value
}

export const dayEndMs = (day) => Date.parse(day) + DAY_MS

export const weekOf = (day) => {
  const time = Date.parse(day)
  const weekday = (new Date(time).getUTCDay() + 6) % 7
  return dayOf(time - weekday * DAY_MS)
}

export const monthOf = (day) => day.slice(0, 7)

export const addDays = (day, count) => dayOf(Date.parse(day) + count * DAY_MS)

export const addMonths = (day, count) => {
  const date = new Date(Date.parse(day))
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0))
  first.setUTCDate(Math.min(date.getUTCDate(), last.getUTCDate()))
  return dayOf(first.getTime())
}

export const dayCount = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1

export const PERIOD_KINDS = ['weeks', 'months']

export const PERIOD_NAMES = { weeks: 'week', months: 'month' }

export const periodOf = (kind, day) => (kind === 'weeks' ? weekOf(day) : monthOf(day))

export const isPeriodId = (kind, id) => {
  if (kind === 'weeks') return isDay(id) && weekOf(id) === id
  if (kind === 'months') {
    return typeof id === 'string' && MONTH_PATTERN.test(id) && isDay(`${id}-01`)
  }
  return false
}

export const periodDays = (kind, id) => {
  const first = kind === 'weeks' ? id : `${id}-01`
  const days = []
  for (let time = Date.parse(first);; time += DAY_MS) {
    const day = dayOf(time)
    if (days.length && periodOf(kind, day) !== id) return days
    days.push(day)
  }
}
