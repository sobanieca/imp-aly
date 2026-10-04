import { labelOf, NULL_LABEL } from './rows.js'

export const MAX_ROWS = 100_000

export const RARELY_USED = { minSeen: 100, maxShare: 5 }

export const NEVER_REACHED = 'Never reached'

export const NEVER_USED = 'Never used'

export const RARELY = 'Seen, rarely used'

export const changeOf = (current, previous) => {
  if (!previous) {
    return current
      ? { direction: 'up', percent: null, text: 'new' }
      : { direction: 'same', percent: 0, text: 'no change' }
  }
  const percent = Math.round(((current - previous) / previous) * 100)
  if (!percent) return { direction: 'same', percent: 0, text: 'no change' }
  const direction = percent > 0 ? 'up' : 'down'
  return { direction, percent, text: `${direction} ${Math.abs(percent)}%` }
}

export const shareOf = (part, whole) => (whole ? (part / whole) * 100 : null)

export const leastVisited = (rows, mapPages, count = 10) => {
  const views = new Map()
  for (const row of rows) {
    if (row.page !== null && row.page !== undefined) views.set(row.page, row.records ?? 0)
  }
  const pages = [...new Set([...mapPages, ...views.keys()])].map((page) => ({
    page,
    views: views.get(page) ?? 0,
    never: !views.get(page),
  })).sort((a, b) => a.views - b.views || (a.page < b.page ? -1 : 1))
  const never = pages.filter((entry) => entry.never).length
  return pages.slice(0, Math.max(count, never))
}

export const zoneFlag = ({ seen, used }) => {
  if (!used) return NEVER_USED
  if (seen >= RARELY_USED.minSeen && (used / seen) * 100 < RARELY_USED.maxShare) return RARELY
  return null
}

export const zoneRows = (rows) => {
  const table = new Map()
  for (const row of rows) {
    if (row.zone === null || row.zone === undefined) continue
    const id = `${row.zone} ${labelOf(row.page)}`
    const entry = table.get(id) ?? { id, zone: row.zone, page: labelOf(row.page), seen: 0, used: 0 }
    if (row.type === 'seen') entry.seen += row.records ?? 0
    if (row.type === 'used') entry.used += row.records ?? 0
    table.set(id, entry)
  }
  return [...table.values()].map((entry) => ({
    ...entry,
    share: shareOf(entry.used, entry.seen),
    flag: zoneFlag(entry),
  }))
}

export const errorRows = (rows) => {
  const table = new Map()
  for (const row of rows) {
    const page = labelOf(row.page)
    const entry = table.get(page) ?? { id: page, page, views: 0, errors: 0 }
    if (row.type === 'page') entry.views += row.records ?? 0
    if (row.type === 'error') entry.errors += row.records ?? 0
    table.set(page, entry)
  }
  return [...table.values()].map((entry) => ({
    ...entry,
    per100: entry.views ? (entry.errors / entry.views) * 100 : null,
  }))
}

const valueOf = (label) => (label === NULL_LABEL ? null : label)

export const emptyFilters = (segments = []) => ({
  page: '',
  zone: '',
  country: '',
  name: [],
  segment: Object.fromEntries(segments.map((name) => [name, ''])),
})

export const activeFilters = (values) => {
  const where = {}
  for (const field of ['page', 'zone', 'country']) {
    if (values?.[field]) where[field] = valueOf(values[field])
  }
  if (values?.name?.length) where.name = values.name.map(valueOf)
  for (const [name, value] of Object.entries(values?.segment ?? {})) {
    if (value) where[name] = valueOf(value)
  }
  return where
}

export const withoutFields = (where, fields) =>
  Object.fromEntries(Object.entries(where).filter(([field]) => !fields.includes(field)))
