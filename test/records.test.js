import { normalizeCountry, validateRecord } from '../src/records.js'
import { assert, assertEquals } from './assert.js'

const app = { pages: new Set(['/', '/invoices/:id']), segments: ['plan'] }

const NOW = 1759300006100

const base = { visit: 'k3v9a1c2', at: NOW, page: '/invoices/:id' }

const check = (input, country = null) => validateRecord(input, app, country, NOW)

Deno.test('accepts each record type of imp', () => {
  assertEquals(check({ type: 'page', ...base, readyMs: 420.6 }).record, {
    type: 'page',
    ...base,
    readyMs: 421,
  })
  assertEquals(
    check({ type: 'seen', ...base, zone: 'myapp.send' }).record.zone,
    'myapp.send',
  )
  assertEquals(check({ type: 'interaction', ...base, zone: null }).record, {
    type: 'interaction',
    ...base,
  })
  assertEquals(
    check({ type: 'outcome', ...base, name: 'myapp.sent' }).record.name,
    'myapp.sent',
  )
  assertEquals(check({ type: 'error', ...base }).record, { type: 'error', ...base })
})

Deno.test('keeps declared segments and the country', () => {
  const { record } = check({ type: 'error', ...base, plan: 'pro' }, 'PL')
  assertEquals(record, { type: 'error', ...base, country: 'PL', plan: 'pro' })
  assertEquals(check({ type: 'error', ...base, plan: null }).record.plan, undefined)
  assertEquals(check({ type: 'error', ...base, plan: 3 }).record.plan, '3')
})

Deno.test('rejects malformed records', () => {
  const problems = [
    null,
    [],
    'text',
    { type: 'click', ...base },
    { type: 'error', ...base, page: '/off-the-map' },
    { type: 'error', ...base, page: '/invoices/42' },
    { type: 'error', ...base, visit: 'a b' },
    { type: 'error', ...base, visit: 'x'.repeat(65) },
    { type: 'error', ...base, at: 'now' },
    { type: 'error', ...base, at: -1 },
    { type: 'error', ...base, at: NOW - 86_400_001 },
    { type: 'error', ...base, at: NOW + 3_600_001 },
    { type: 'error', ...base, extra: 1 },
    { type: 'error', ...base, country: 'PL' },
    { type: 'error', ...base, plan: 'a\nb' },
    { type: 'error', ...base, plan: 'x'.repeat(65) },
    { type: 'error', ...base, plan: {} },
    { type: 'page', ...base },
    { type: 'page', ...base, readyMs: -1 },
    { type: 'page', ...base, readyMs: 4_000_000 },
    { type: 'page', ...base, readyMs: 1, zone: 'myapp.x' },
    { type: 'seen', ...base, zone: 'nonamespace' },
    { type: 'seen', ...base, zone: null },
    { type: 'seen', ...base, zone: 'my app.x' },
    { type: 'seen', ...base, zone: 'myapp.\tx' },
    { type: 'interaction', ...base },
    { type: 'outcome', ...base, name: 'sent' },
  ]
  for (const input of problems) {
    const result = check(input)
    assert(result.problem && !result.record, `accepted ${JSON.stringify(input)}`)
  }
})

Deno.test('normalizes the country header', () => {
  assertEquals(normalizeCountry('pl'), 'PL')
  assertEquals(normalizeCountry('T1'), 'T1')
  assertEquals(normalizeCountry('Poland'), null)
  assertEquals(normalizeCountry(null), null)
})
