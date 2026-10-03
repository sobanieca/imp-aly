export const FAST_MS = 2500

export const fastMeasure = (limit = FAST_MS) => `readyMs.under:${limit}`

export const BASE_DIMENSIONS = ['type', 'page', 'zone', 'name', 'country', 'visit']

export const RECORD_TYPES = ['page', 'seen', 'interaction', 'outcome', 'error']

export const COMMON_MEASURES = [
  'records',
  'visits',
  'readyMs.avg',
  'readyMs.min',
  'readyMs.max',
  'readyMs.p50',
  'readyMs.p75',
  'readyMs.p95',
  'readyMs.p99',
  'readyMs.under:1000',
  'readyMs.under:2500',
  'readyMs.under:4000',
]
