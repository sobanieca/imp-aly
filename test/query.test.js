import { sealDay } from '../src/column-store.js'
import { parseQuery } from '../src/query-core.js'
import { applySegment } from '../src/storage.js'
import { assertEquals, assertThrows, temporaryDir } from './assert.js'
import { ask, dayPath, SOURCE } from './fixtures.js'

const VISITS = [
  ['2026-10-01', '/invoice', 'PL', 'pro'],
  ['2026-10-01', '/invoice/:id', 'PL', 'pro'],
  ['2026-10-01', '/invoice', 'EN', 'enterprise'],
  ['2026-10-01', '/invoice', 'PL', 'free'],
  ['2026-10-02', '/invoice', 'EN', 'pro'],
  ['2026-10-02', '/invoice/:id', 'PL', 'pro'],
  ['2026-10-02', '/invoice', 'PL', 'pro'],
  ['2026-10-02', '/invoice', 'EN', 'enterprise'],
]

const fill = async () => {
  const dataDir = await temporaryDir()
  let text = ''
  VISITS.forEach(([day, page, country, plan], index) => {
    const record = {
      type: 'page',
      visit: `v${index % 3}`,
      at: 1 + index,
      page,
      country,
      plan,
    }
    text += `${JSON.stringify(['myapp', day, record])}\n`
  })
  await applySegment({ dataDir, source: SOURCE, segment: 1, text })
  return dataDir
}

const NOW = Date.parse('2026-10-02T12:00:00Z')

Deno.test('visits per day where country is PL and plan is pro', async () => {
  const dataDir = await fill()
  const query = parseQuery({
    app: 'myapp',
    from: '2026-10-01',
    to: '2026-10-02',
    where: { country: 'PL', plan: 'pro' },
    groupBy: ['day'],
  }, NOW)
  const result = await ask(dataDir, query)
  assertEquals(result.rows, [{ day: '2026-10-01', records: 2 }, { day: '2026-10-02', records: 2 }])
  assertEquals(result.scanned, 8)
  assertEquals(result.matched, 4)
  await sealDay(dayPath(dataDir, '2026-10-01'))
  assertEquals((await ask(dataDir, query)).rows, result.rows)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('visits per page and limits', async () => {
  const dataDir = await fill()
  const query = parseQuery({
    app: 'myapp',
    from: '2026-10-01',
    to: '2026-10-02',
    groupBy: ['page'],
    measures: ['records', 'visits'],
  }, NOW)
  const result = await ask(dataDir, query)
  assertEquals(result.rows, [
    { page: '/invoice', records: 6, visits: 4 },
    { page: '/invoice/:id', records: 2, visits: 2 },
  ])
  const limited = await ask(dataDir, { ...query, limit: 1 })
  assertEquals(limited.rows.length, 1)
  assertEquals(limited.truncated, true)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a week or a month adds up the visits of its days', async () => {
  const dataDir = await fill()
  const range = { app: 'myapp', from: '2026-10-01', to: '2026-10-02', measures: ['visits'] }
  const weeks = await ask(dataDir, parseQuery({ ...range, groupBy: ['week'] }, NOW))
  assertEquals(weeks.rows, [{ week: '2026-09-28', visits: 6 }])
  const months = await ask(dataDir, parseQuery({ ...range, groupBy: ['month', 'plan'] }, NOW))
  assertEquals(months.rows, [
    { month: '2026-10', plan: 'pro', visits: 5 },
    { month: '2026-10', plan: 'enterprise', visits: 2 },
    { month: '2026-10', plan: 'free', visits: 1 },
  ])
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a query with no match still counts zero', async () => {
  const dataDir = await fill()
  const query = parseQuery({
    app: 'myapp',
    where: { country: 'DE' },
    measures: ['records', 'visits'],
  }, NOW)
  assertEquals((await ask(dataDir, query)).rows, [{ records: 0, visits: 0 }])
  const other = parseQuery({ app: 'nothing' }, NOW)
  assertEquals((await ask(dataDir, other)).days, 0)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('queries are validated', () => {
  assertEquals(parseQuery({ app: 'myapp' }, NOW).from, '2026-10-02')
  assertThrows(() => parseQuery({}, NOW), /app/)
  assertThrows(() => parseQuery({ app: '../etc' }, NOW), /app/)
  assertThrows(() => parseQuery({ app: 'a', from: '2026-02-30' }, NOW), /from/)
  assertThrows(() => parseQuery({ app: 'a', from: '2026-10-02', to: '2026-10-01' }, NOW), /after/)
  assertThrows(() => parseQuery({ app: 'a', where: { day: '1' } }, NOW), /dimension/)
  assertThrows(() => parseQuery({ app: 'a', where: { week: '1' } }, NOW), /dimension/)
  assertThrows(() => parseQuery({ app: 'a', where: { 'x/y': '1' } }, NOW), /dimension/)
  assertThrows(() => parseQuery({ app: 'a', where: { page: 1 } }, NOW), /text/)
  assertThrows(() => parseQuery({ app: 'a', groupBy: ['at'] }, NOW), /dimension/)
  assertThrows(() => parseQuery({ app: 'a', measures: ['sum'] }, NOW), /records and visits/)
  assertThrows(() => parseQuery({ app: 'a', measures: ['readyMs.p75'] }, NOW), /records and visits/)
  assertThrows(() => parseQuery({ app: 'a', groupBy: ['day', 'week'] }, NOW), /one of day/)
  assertThrows(() => parseQuery({ app: 'a', groupBy: ['constructor'] }, NOW), /dimension/)
  assertThrows(() => parseQuery({ app: 'a', limit: 0 }, NOW), /limit/)
  assertThrows(() => parseQuery({ app: 'a', select: [] }, NOW), /unknown/)
})
