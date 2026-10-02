import { MAX_READY_MS } from './ready.js'

const VISIT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const NAMESPACED_NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/

const SEGMENT_VALUE = /^[A-Za-z0-9._-]{1,64}$/

const hasControlCharacter = (text) => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

const MAX_NAME_LENGTH = 128

const COUNTRY_PATTERN = /^[A-Z][A-Z0-9]$/

export const MAX_RECORD_AGE_MS = 3_600_000

export const MAX_RECORD_AHEAD_MS = 3_600_000

const COMMON_FIELDS = ['type', 'visit', 'at', 'page']

export const TYPE_FIELDS = {
  page: ['readyMs'],
  seen: ['zone'],
  interaction: ['zone'],
  outcome: ['name'],
  error: [],
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype

export const isName = (value) =>
  typeof value === 'string' && value.length <= MAX_NAME_LENGTH && NAMESPACED_NAME.test(value)

export const isSegmentValue = (value) => typeof value === 'string' && SEGMENT_VALUE.test(value)

export const isCountry = (value) => typeof value === 'string' && COUNTRY_PATTERN.test(value)

const segmentValue = (value) => {
  if (value === null || value === undefined || value === '') return { value: null }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { problem: 'not a finite number' }
  }
  const text = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
  if (isSegmentValue(text)) return { value: text }
  return { problem: 'not a text of 1 to 64 letters, digits, ".", "-" or "_"' }
}

export const normalizeCountry = (value) => {
  const country = String(value ?? '').trim().toUpperCase()
  return isCountry(country) ? country : null
}

export const isSafeText = (value) => typeof value === 'string' && !hasControlCharacter(value)

export const validateRecord = (input, app, country = null, now = Date.now()) => {
  if (!isPlainObject(input)) return { problem: 'record is not an object' }
  const { type } = input
  if (typeof type !== 'string' || !Object.hasOwn(TYPE_FIELDS, type)) {
    return { problem: 'type is not one of page, seen, interaction, outcome, error' }
  }
  const allowed = new Set([...COMMON_FIELDS, ...TYPE_FIELDS[type], ...app.segments])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return { problem: `field "${key.slice(0, 40)}" is not allowed` }
  }
  if (typeof input.visit !== 'string' || !VISIT_PATTERN.test(input.visit)) {
    return { problem: 'visit is not an id of 1 to 64 letters, digits, "-" or "_"' }
  }
  if (!Number.isSafeInteger(input.at) || input.at <= 0) {
    return { problem: 'at is not a time in milliseconds' }
  }
  if (input.at < now - MAX_RECORD_AGE_MS) return { problem: 'at is more than 1 hour old' }
  if (input.at > now + MAX_RECORD_AHEAD_MS) return { problem: 'at is more than 1 hour ahead' }
  if (typeof input.page !== 'string' || !app.pages.has(input.page)) {
    return { problem: 'page is not on the app map' }
  }
  const record = { type, visit: input.visit, at: input.at, page: input.page }
  if (type === 'page') {
    const { readyMs } = input
    if (typeof readyMs !== 'number' || !(readyMs >= 0) || readyMs > MAX_READY_MS) {
      return { problem: 'readyMs is not a number of milliseconds from 0 to 3600000' }
    }
    record.readyMs = Math.round(readyMs)
  }
  if (type === 'seen') {
    if (!isName(input.zone)) return { problem: 'zone is not a namespaced name' }
    record.zone = input.zone
  }
  if (type === 'interaction') {
    if (!Object.hasOwn(input, 'zone')) return { problem: 'zone is missing' }
    if (input.zone !== null && !isName(input.zone)) {
      return { problem: 'zone is not a namespaced name or null' }
    }
    if (input.zone !== null) record.zone = input.zone
  }
  if (type === 'outcome') {
    if (!isName(input.name)) return { problem: 'name is not a namespaced name' }
    record.name = input.name
  }
  if (country !== null) record.country = country
  for (const segment of app.segments) {
    if (!Object.hasOwn(input, segment)) continue
    const result = segmentValue(input[segment])
    if (result.problem) return { problem: `segment "${segment}" is ${result.problem}` }
    if (result.value !== null) record[segment] = result.value
  }
  return { record }
}
