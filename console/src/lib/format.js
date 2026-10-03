const counts = new Intl.NumberFormat('en')

export const formatCount = (
  value,
) => (value === null || value === undefined ? '-' : counts.format(value))

export const formatPercent = (value) =>
  value === null || value === undefined ? '-' : `${Number(value).toFixed(1)}%`

export const formatMs = (value) => {
  if (value === null || value === undefined) return '-'
  if (value < 1000) return `${Math.round(value)} ms`
  return `${Number((value / 1000).toFixed(value < 10_000 ? 2 : 1))} s`
}

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

const isShare = (measure) => measure.startsWith('readyMs.under:')

const isDuration = (measure) => measure.startsWith('readyMs.') && !isShare(measure)

export const formatMeasure = (measure, value) => {
  if (isShare(measure)) return formatPercent(value)
  if (isDuration(measure)) return formatMs(value)
  return formatCount(value)
}

export const measureLabel = (measure) => {
  if (measure === 'records') return 'Records'
  if (measure === 'visits') return 'Visits'
  if (isShare(measure)) return `Ready under ${formatMs(Number(measure.split(':')[1]))}`
  const name = measure.slice('readyMs.'.length)
  if (name === 'avg') return 'Average ready time'
  if (name === 'min') return 'Fastest ready time'
  if (name === 'max') return 'Slowest ready time'
  return `Ready time ${name}`
}

export const formatDateTime = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}
