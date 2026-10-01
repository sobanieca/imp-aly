import { sealDay } from '../src/column-store.js'
import { parseQuery, runQuery } from '../src/query.js'
import { applySegment } from '../src/storage.js'
import { assertEquals, assertThrows, temporaryDir } from './assert.js'

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
      readyMs: (index + 1) * 100,
      country,
      plan,
    }
    text += `${JSON.stringify(['myapp', day, record])}\n`
  })
  await applySegment({ dataDir, segment: 1, text })
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
  const result = await runQuery({ dataDir, query })
  assertEquals(result.rows, [{ day: '2026-10-01', records: 2 }, { day: '2026-10-02', records: 2 }])
  assertEquals(result.scanned, 8)
  assertEquals(result.matched, 4)
  await sealDay(`${dataDir}/apps/myapp/2026-10-01`)
  assertEquals((await runQuery({ dataDir, query })).rows, result.rows)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('visits per day, ready time percentiles and limits', async () => {
  const dataDir = await fill()
  const query = parseQuery({
    app: 'myapp',
    from: '2026-10-01',
    to: '2026-10-02',
    groupBy: ['page'],
    measures: ['records', 'visits', 'readyMs.p50', 'readyMs.max', 'readyMs.avg'],
  }, NOW)
  const result = await runQuery({ dataDir, query })
  assertEquals(result.rows, [
    {
      page: '/invoice',
      records: 6,
      visits: 4,
      'readyMs.p50': 450,
      'readyMs.max': 800,
      'readyMs.avg': 466.7,
    },
    {
      page: '/invoice/:id',
      records: 2,
      visits: 2,
      'readyMs.p50': 400,
      'readyMs.max': 600,
      'readyMs.avg': 400,
    },
  ])
  const limited = await runQuery({ dataDir, query: { ...query, limit: 1 } })
  assertEquals(limited.rows.length, 1)
  assertEquals(limited.truncated, true)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a query with no match still counts zero', async () => {
  const dataDir = await fill()
  const query = parseQuery({
    app: 'myapp',
    where: { country: 'DE' },
    measures: ['records', 'visits'],
  }, NOW)
  assertEquals((await runQuery({ dataDir, query })).rows, [{ records: 0, visits: 0 }])
  const other = parseQuery({ app: 'nothing' }, NOW)
  assertEquals((await runQuery({ dataDir, query: other })).days, 0)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('queries are validated', () => {
  assertEquals(parseQuery({ app: 'myapp' }, NOW).from, '2026-10-02')
  assertThrows(() => parseQuery({}, NOW), /app/)
  assertThrows(() => parseQuery({ app: '../etc' }, NOW), /app/)
  assertThrows(() => parseQuery({ app: 'a', from: '2026-02-30' }, NOW), /from/)
  assertThrows(() => parseQuery({ app: 'a', from: '2026-10-02', to: '2026-10-01' }, NOW), /after/)
  assertThrows(() => parseQuery({ app: 'a', where: { readyMs: '1' } }, NOW), /dimension/)
  assertThrows(() => parseQuery({ app: 'a', where: { 'x/y': '1' } }, NOW), /dimension/)
  assertThrows(() => parseQuery({ app: 'a', where: { page: 1 } }, NOW), /text/)
  assertThrows(() => parseQuery({ app: 'a', groupBy: ['at'] }, NOW), /dimension/)
  assertThrows(() => parseQuery({ app: 'a', measures: ['sum'] }, NOW), /not known/)
  assertThrows(() => parseQuery({ app: 'a', measures: ['readyMs.p100'] }, NOW), /not known/)
  assertThrows(() => parseQuery({ app: 'a', limit: 0 }, NOW), /limit/)
  assertThrows(() => parseQuery({ app: 'a', select: [] }, NOW), /unknown/)
})
