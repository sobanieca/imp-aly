export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const DAY_MS = 86_400_000

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

export const isDay = (value) => {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false
  const ms = Date.parse(value)
  return Number.isFinite(ms) && dayOf(ms) === value
}

export const dayEndMs = (day) => Date.parse(day) + DAY_MS
