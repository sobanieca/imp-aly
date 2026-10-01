import { sealDay } from '../src/column-store.js'
import { canUseSummary, parseQuery, runQuery } from '../src/query.js'
import { applySegment } from '../src/storage.js'
import { assertEquals, temporaryDir } from './assert.js'

const DAYS = ['2026-09-20', '2026-09-21']

const PAGES = ['/', '/invoices', '/invoices/:id']

const fill = async () => {
  const dataDir = await temporaryDir()
  let text = ''
  let seed = 7
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (const day of DAYS) {
    for (let visit = 0; visit < 40; visit++) {
      const visitId = `v${visit % 30}`
      const plan = visit % 3 === 0 ? null : ['pro', 'free'][visit % 2]
      for (let step = 0; step < 12; step++) {
        const type = ['page', 'seen', 'interaction', 'interaction', 'outcome', 'error'][next(6)]
        const record = {
          type,
          visit: visitId,
          at: Date.parse(day) + visit * 1000 + step,
          page: PAGES[next(3)],
          country: visit % 4 ? 'PL' : 'DE',
        }
        if (plan) record.plan = plan
        if (type === 'page') record.readyMs = 50 + next(500)
        if (type === 'seen' || (type === 'interaction' && next(2))) {
          record.zone = `myapp.zone-${next(4)}`
        }
        if (type === 'outcome') record.name = `myapp.done-${next(2)}`
        text += `${JSON.stringify(['myapp', day, record])}\n`
      }
    }
  }
  await applySegment({ dataDir, segment: 1, text })
  return dataDir
}

const QUERIES = [
  { measures: ['records', 'visits'] },
  { groupBy: ['day'], measures: ['visits', 'records'] },
  { groupBy: ['page', 'type'], measures: ['records', 'visits'] },
  {
    where: { type: 'page' },
    groupBy: ['page'],
    measures: ['readyMs.p75', 'readyMs.p50', 'records'],
  },
  {
    where: { type: 'page' },
    measures: ['readyMs.avg', 'readyMs.min', 'readyMs.max', 'readyMs.p99'],
  },
  { where: { type: ['seen', 'interaction'] }, groupBy: ['zone', 'type'] },
  { where: { type: 'outcome', page: '/invoices/:id' }, groupBy: ['name'] },
  { where: { country: 'PL', plan: 'pro' }, groupBy: ['day'], measures: ['records', 'visits'] },
  { where: { plan: null }, groupBy: ['country', 'plan'], measures: ['visits'] },
  { groupBy: ['plan', 'country', 'day'], measures: ['visits', 'records'] },
  { where: { zone: 'myapp.zone-1' }, measures: ['visits'] },
  { groupBy: ['visit'], measures: ['records'], limit: 5 },
]

const NOW = Date.parse('2026-10-01T12:00:00Z')

Deno.test('summaries answer every query exactly like a scan', async () => {
  const dataDir = await fill()
  const queries = QUERIES.map((fields) =>
    parseQuery({ app: 'myapp', from: DAYS[0], to: DAYS[1], ...fields }, NOW)
  )
  const scanned = []
  for (const query of queries) scanned.push(await runQuery({ dataDir, query }))
  for (const day of DAYS) await sealDay(`${dataDir}/apps/myapp/${day}`)
  for (const [index, query] of queries.entries()) {
    const result = await runQuery({ dataDir, query })
    assertEquals(result.summaryDays, canUseSummary(query) ? 2 : 0, `summary days of ${index}`)
    assertEquals(
      { ...result, summaryDays: 0 },
      { ...scanned[index], summaryDays: 0 },
      `query ${index}`,
    )
  }
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a day with late records is scanned', async () => {
  const dataDir = await fill()
  const path = `${dataDir}/apps/myapp/${DAYS[0]}`
  await sealDay(path)
  const late = { type: 'error', visit: 'late', at: Date.parse(DAYS[0]), page: '/' }
  await applySegment({ dataDir, segment: 2, text: `${JSON.stringify(['myapp', DAYS[0], late])}\n` })
  const query = parseQuery({ app: 'myapp', from: DAYS[0], measures: ['records', 'visits'] }, NOW)
  const result = await runQuery({ dataDir, query })
  assertEquals(result.summaryDays, 0)
  assertEquals(result.rows[0].records, 481)
  await sealDay(path)
  assertEquals((await runQuery({ dataDir, query })).summaryDays, 1)
  assertEquals((await runQuery({ dataDir, query })).rows, result.rows)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('visits by zone or name need a scan', () => {
  const parse = (fields) => parseQuery({ app: 'myapp', ...fields }, NOW)
  assertEquals(canUseSummary(parse({ groupBy: ['zone'] })), true)
  assertEquals(canUseSummary(parse({ groupBy: ['zone'], measures: ['visits'] })), false)
  assertEquals(canUseSummary(parse({ where: { name: 'a.b' }, measures: ['visits'] })), false)
  assertEquals(canUseSummary(parse({ where: { visit: 'v1' } })), false)
})
