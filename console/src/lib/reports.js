import { formatCount } from './format.js'
import { labelOf, NULL_LABEL } from './rows.js'

export const MAX_ROWS = 100_000

export const MAX_VALUES = 300

export const RARELY_USED = { minShown: 100, maxShare: 5 }

export const NEVER_REACHED = 'Never reached'

export const NEVER_USED = 'Never used'

export const RARELY = 'Seen, rarely used'

export const RARELY_VIEWED = 'Viewed, rarely used'

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

const usageFlag = (shown, used, rarely) => {
  if (!used) return NEVER_USED
  if (shown >= RARELY_USED.minShown && (used / shown) * 100 < RARELY_USED.maxShare) return rarely
  return null
}

export const zoneFlag = ({ seen, used }) => usageFlag(seen, used, RARELY)

export const pageFlag = ({ views, used }) =>
  views ? usageFlag(views, used, RARELY_VIEWED) : NEVER_REACHED

export const leastUsed = (rows, count = 10) => {
  const sorted = [...rows].sort((a, b) =>
    a.used - b.used || b.views - a.views || (a.page < b.page ? -1 : 1)
  )
  return sorted.slice(0, Math.max(count, rows.filter((row) => !row.used).length))
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

export const pageRows = (rows, mapPages = []) => {
  const table = new Map(mapPages.map((page) => [page, { id: page, page, views: 0, used: 0 }]))
  for (const row of rows) {
    const page = labelOf(row.page)
    const entry = table.get(page) ?? { id: page, page, views: 0, used: 0 }
    if (row.type === 'page') entry.views += row.records ?? 0
    if (row.type === 'used') entry.used += row.records ?? 0
    table.set(page, entry)
  }
  return [...table.values()].map((entry) => ({
    ...entry,
    share: shareOf(entry.used, entry.views),
    flag: pageFlag(entry),
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
  page: [],
  zone: '',
  country: [],
  name: [],
  segment: Object.fromEntries(segments.map((name) => [name, []])),
})

const listOf = (value) => (Array.isArray(value) ? value : value ? [value] : [])

export const activeFilters = (values) => {
  const where = {}
  if (values?.zone) where.zone = valueOf(values.zone)
  for (const field of ['page', 'country', 'name']) {
    const chosen = listOf(values?.[field])
    if (chosen.length) where[field] = chosen.map(valueOf)
  }
  for (const [name, value] of Object.entries(values?.segment ?? {})) {
    const chosen = listOf(value)
    if (chosen.length) where[name] = chosen.map(valueOf)
  }
  return where
}

export const withoutFields = (where, fields) =>
  Object.fromEntries(Object.entries(where).filter(([field]) => !fields.includes(field)))

export const shownNote = (shown, total, noun) =>
  shown < total ? `Showing ${formatCount(shown)} of ${formatCount(total)} ${noun}.` : null

export const errorTableNote = ({ chosen, withErrors, shown }) => {
  if (!chosen) return shownNote(shown, withErrors, 'pages with errors')
  const clean = chosen - withErrors
  return clean > 0
    ? `Showing ${formatCount(shown)} of ${formatCount(chosen)} chosen pages. The table leaves out ${
      formatCount(clean)
    } chosen ${clean === 1 ? 'page' : 'pages'} with no errors.`
    : null
}

export const outcomeTableRows = (rows, chosen, top) => {
  const names = rows.map((row) => labelOf(row.name))
  const shown = chosen.length
    ? [...new Set([...names, ...chosen.map(labelOf)])]
    : names.slice(0, top)
  const counts = new Map(rows.map((row) => [labelOf(row.name), row.records]))
  return {
    rows: shown.map((name) => ({ name, records: counts.get(name) ?? 0 })),
    note: chosen.length ? null : shownNote(shown.length, names.length, 'outcomes'),
  }
}

export const cutListHelp = (truncated, { canType = false } = {}) => {
  if (!truncated) return undefined
  const shown = `The list shows the ${formatCount(MAX_VALUES)} values with the most records.`
  return canType ? `${shown} Type another value and press Enter.` : shown
}

export const usesTitle = (value) => `Uses of ${labelOf(value)}`
