const counts = new Intl.NumberFormat('en')

export const formatCount = (
  value,
) => (value === null || value === undefined ? '-' : counts.format(value))

export const formatPercent = (value) =>
  value === null || value === undefined ? '-' : `${Number(value).toFixed(1)}%`

export const formatBytes = (bytes) => {
  if (bytes === null || bytes === undefined) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`
}

export const formatDateTime = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}
