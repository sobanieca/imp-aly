const DAY_MS = 86_400_000

const MAX_CHART_DAYS = 400

export const todayUtc = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

export const addDays = (day, count) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10)

export const daysBetween = (from, to) => {
  const days = []
  for (let day = from; day <= to && days.length < MAX_CHART_DAYS; day = addDays(day, 1)) {
    days.push(day)
  }
  return days
}

export const PRESETS = [
  { value: '1', label: 'Today' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
]

export const presetRange = (preset, now = Date.now()) => {
  const end = todayUtc(now)
  return { start: addDays(end, 1 - Number(preset)), end }
}

export const presetOf = (range, now = Date.now()) =>
  PRESETS.find(({ value }) => {
    const candidate = presetRange(value, now)
    return candidate.start === range?.start && candidate.end === range?.end
  })?.value

export const shortDay = (day) => day.slice(5)
