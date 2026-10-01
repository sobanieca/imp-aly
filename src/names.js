export const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

export const SEGMENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/

export const BASE_COLUMNS = ['type', 'visit', 'at', 'page', 'readyMs', 'zone', 'name', 'country']

export const RESERVED_NAMES = new Set([...BASE_COLUMNS, 'day', 'records', 'visits'])

export const MAX_SEGMENTS = 16

export const isAppName = (value) => typeof value === 'string' && APP_NAME_PATTERN.test(value)

export const isColumnName = (value) =>
  typeof value === 'string' && (BASE_COLUMNS.includes(value) || SEGMENT_NAME_PATTERN.test(value))
