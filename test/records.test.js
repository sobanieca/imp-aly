import { normalizeCountry, validateRecord } from '../src/records.js'
import { assert, assertEquals } from './assert.js'

const LONG_NAME = `myapp.${'x'.repeat(122)}`

const app = {
  pages: new Set(['/', '/invoices/:id']),
  zones: new Set(['myapp.send', 'my_app.Zone-2.a']),
  outcomes: new Set(['myapp.sent', LONG_NAME]),
  segments: ['plan'],
}

const NOW = 1759300006100

const base = { visit: 'k3v9a1c2', at: NOW, page: '/invoices/:id' }

const check = (input, country = null) => validateRecord(input, app, country, NOW)

Deno.test('accepts each record type of imp', () => {
  assertEquals(check({ type: 'page', ...base }).record, { type: 'page', ...base })
  assertEquals(
    check({ type: 'seen', ...base, zone: 'myapp.send' }).record.zone,
    'myapp.send',
  )
  assertEquals(check({ type: 'used', ...base, zone: null }).record, {
    type: 'used',
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

Deno.test('keeps segment values and names of plain characters', () => {
  for (const value of ['en-US', '1.2.3', 'free_trial', -1, 0.5, true]) {
    assertEquals(check({ type: 'error', ...base, plan: value }).record.plan, String(value))
  }
  assertEquals(check({ type: 'outcome', ...base, name: LONG_NAME }).record.name, LONG_NAME)
  assertEquals(
    check({ type: 'seen', ...base, zone: 'my_app.Zone-2.a' }).record.zone,
    'my_app.Zone-2.a',
  )
})

Deno.test('rejects segment values and names with other characters', () => {
  const values = [
    '<script>alert(1)</script>',
    '$(rm -rf /)',
    'a b',
    'pro;',
    "o'brien",
    'krak\u00f3w',
    'pro\u202e',
    'pro\u200b',
    'pro\u009b',
    'a\u2028b',
    1e21,
    NaN,
    Infinity,
  ]
  for (const plan of values) {
    const result = check({ type: 'error', ...base, plan })
    assert(result.problem && !result.record, `accepted ${JSON.stringify(plan)}`)
  }
  const names = [
    '<script>.x',
    'myapp.<b>',
    'myapp.caf\u00e9',
    'myapp.a$b',
    'myapp.a/b',
    'myapp..x',
    '.myapp.x',
    'myapp.x.',
    `myapp.${'x'.repeat(123)}`,
  ]
  for (const name of names) {
    const result = check({ type: 'outcome', ...base, name })
    assert(result.problem && !result.record, `accepted ${JSON.stringify(name)}`)
    const zone = check({ type: 'seen', ...base, zone: name })
    assert(zone.problem && !zone.record, `accepted ${JSON.stringify(name)}`)
  }
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
    { type: 'error', ...base, at: NOW - 3_600_001 },
    { type: 'error', ...base, at: NOW + 3_600_001 },
    { type: 'error', ...base, extra: 1 },
    { type: 'error', ...base, country: 'PL' },
    { type: 'error', ...base, plan: 'a\nb' },
    { type: 'error', ...base, plan: 'x'.repeat(65) },
    { type: 'error', ...base, plan: {} },
    { type: 'page', ...base, readyMs: 420 },
    { type: 'page', ...base, zone: 'myapp.x' },
    { type: 'seen', ...base, zone: 'nonamespace' },
    { type: 'seen', ...base, zone: null },
    { type: 'seen', ...base, zone: 'my app.x' },
    { type: 'seen', ...base, zone: 'myapp.\tx' },
    { type: 'used', ...base },
    { type: 'interaction', ...base, zone: null },
    { type: 'outcome', ...base, name: 'sent' },
  ]
  for (const input of problems) {
    const result = check(input)
    assert(result.problem && !result.record, `accepted ${JSON.stringify(input)}`)
  }
})

Deno.test('accepts only the zones and the outcomes of app-analytics.json', () => {
  assertEquals(check({ type: 'used', ...base, zone: 'myapp.send' }).record.zone, 'myapp.send')
  assertEquals(check({ type: 'used', ...base, zone: null }).problem, undefined)
  assertEquals(
    check({ type: 'seen', ...base, zone: 'myapp.forged' }).problem,
    'zone is not in the zones of app-analytics.json',
  )
  assertEquals(
    check({ type: 'used', ...base, zone: 'myapp.forged' }).problem,
    'zone is not in the zones of app-analytics.json',
  )
  assertEquals(
    check({ type: 'outcome', ...base, name: 'myapp.forged' }).problem,
    'name is not in the outcomes of app-analytics.json',
  )
  assertEquals(
    check({ type: 'outcome', ...base, name: 'myapp.send' }).problem,
    'name is not in the outcomes of app-analytics.json',
  )
  assertEquals(
    check({ type: 'seen', ...base, zone: 'nonamespace' }).problem,
    'zone is not a namespaced name',
  )
  assertEquals(
    check({ type: 'error', ...base, page: '/off-the-map' }).problem,
    'page is not in the pages of app-analytics.json',
  )
  const empty = { ...app, zones: new Set(), outcomes: new Set() }
  assertEquals(
    validateRecord({ type: 'used', ...base, zone: null }, empty, null, NOW).problem,
    undefined,
  )
  assertEquals(
    validateRecord({ type: 'seen', ...base, zone: 'myapp.send' }, empty, null, NOW).problem,
    'zone is not in the zones of app-analytics.json',
  )
})

Deno.test('normalizes the country header', () => {
  assertEquals(normalizeCountry('pl'), 'PL')
  assertEquals(normalizeCountry('T1'), 'T1')
  assertEquals(normalizeCountry('Poland'), null)
  assertEquals(normalizeCountry(null), null)
})
