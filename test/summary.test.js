import { sealDay, SUMMARY_ONLY_PROBLEM } from '../src/column-store.js'
import { createBackupStream, restoreBackup } from '../src/backup.js'
import { canUseSummary, finalizeQuery, parseQuery, runQuery } from '../src/query.js'
import { checkSummary } from '../src/summary.js'
import { applySegment } from '../src/storage.js'
import { assertEquals, assertThrows, temporaryDir } from './assert.js'
import { ask, DAYS, fill, openFile, saveStream } from './fixtures.js'

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
  { groupBy: ['country'], measures: ['readyMs.under:300', 'readyMs.p95', 'visits'] },
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
  for (const query of queries) scanned.push(await ask(dataDir, query))
  for (const day of DAYS) await sealDay(`${dataDir}/apps/myapp/${day}`)
  for (const [index, query] of queries.entries()) {
    const result = await ask(dataDir, query)
    assertEquals(
      result.servers[0].summaryDays,
      canUseSummary(query) ? 2 : 0,
      `summary days of ${index}`,
    )
    assertEquals(
      { ...result, servers: [] },
      { ...scanned[index], servers: [] },
      `query ${index}`,
    )
  }
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('the answers of two servers with separate visits merge to the answer of one', async () => {
  const visitNumber = (visit) => Number(visit.slice(1))
  const allDir = await fill()
  const evenDir = await fill({ keep: (visit) => visitNumber(visit) % 2 === 0 })
  const oddDir = await fill({ keep: (visit) => visitNumber(visit) % 2 === 1 })
  await sealDay(`${evenDir}/apps/myapp/${DAYS[0]}`)
  for (const day of DAYS) await sealDay(`${allDir}/apps/myapp/${day}`)
  for (const [index, fields] of QUERIES.entries()) {
    const query = parseQuery({ app: 'myapp', from: DAYS[0], to: DAYS[1], ...fields }, NOW)
    const answer = async (server, dataDir) => ({
      server,
      answer: JSON.parse(JSON.stringify(await runQuery({ dataDir, query }))),
    })
    const one = finalizeQuery(query, [await answer('all', allDir)])
    const two = finalizeQuery(query, [await answer('even', evenDir), await answer('odd', oddDir)])
    assertEquals(two.servers.map((server) => server.server), ['even', 'odd'])
    assertEquals({ ...two, servers: [] }, { ...one, servers: [] }, `query ${index}`)
  }
  for (const dataDir of [allDir, evenDir, oddDir]) await Deno.remove(dataDir, { recursive: true })
})

Deno.test('restored summaries answer like the full data, and other queries skip the days', async () => {
  const dataDir = await fill()
  for (const day of DAYS) await sealDay(`${dataDir}/apps/myapp/${day}`)
  const file = `${dataDir}/backup.tar.gz`
  await saveStream(createBackupStream({ dataDir }), file)
  const restoredDir = await temporaryDir()
  const restored = await restoreBackup({
    dataDir: restoredDir,
    open: openFile(file),
    now: NOW,
    sealDelayMs: 0,
  })
  assertEquals(restored.restored.length, 2)
  for (const [index, fields] of QUERIES.entries()) {
    const query = parseQuery({ app: 'myapp', from: DAYS[0], to: DAYS[1], ...fields }, NOW)
    const full = await ask(dataDir, query)
    const result = await ask(restoredDir, query)
    if (canUseSummary(query)) {
      assertEquals(result, full, `query ${index}`)
    } else {
      assertEquals(
        result.skippedDays,
        DAYS.map((day) => ({ server: 'local', day, reason: SUMMARY_ONLY_PROBLEM })),
      )
      assertEquals(result.scanned, 0, `query ${index}`)
    }
  }
  await Deno.remove(dataDir, { recursive: true })
  await Deno.remove(restoredDir, { recursive: true })
})

Deno.test('a day with late records is scanned', async () => {
  const dataDir = await fill()
  const path = `${dataDir}/apps/myapp/${DAYS[0]}`
  await sealDay(path)
  const late = { type: 'error', visit: 'late', at: Date.parse(DAYS[0]), page: '/' }
  await applySegment({ dataDir, segment: 2, text: `${JSON.stringify(['myapp', DAYS[0], late])}\n` })
  const query = parseQuery({ app: 'myapp', from: DAYS[0], measures: ['records', 'visits'] }, NOW)
  const result = await ask(dataDir, query)
  assertEquals(result.servers[0].summaryDays, 0)
  assertEquals(result.rows[0].records, 481)
  await sealDay(path)
  assertEquals((await ask(dataDir, query)).servers[0].summaryDays, 1)
  assertEquals((await ask(dataDir, query)).rows, result.rows)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('visits by zone or name need a scan', () => {
  const parse = (fields) => parseQuery({ app: 'myapp', ...fields }, NOW)
  assertEquals(canUseSummary(parse({ groupBy: ['zone'] })), true)
  assertEquals(canUseSummary(parse({ groupBy: ['zone'], measures: ['visits'] })), false)
  assertEquals(canUseSummary(parse({ where: { name: 'a.b' }, measures: ['visits'] })), false)
  assertEquals(canUseSummary(parse({ where: { visit: 'v1' } })), false)
})

Deno.test('a summary with a value that a record cannot have fails the check', () => {
  const summary = (count, tuple, ready = '1\t\t\t\t') => ({
    counts:
      `type\tpage\tzone\tname\tcountry\tplan\trecords\treadySum\treadyMin\treadyMax\treadyMs\n${count}\t${ready}\n`,
    tuples: `type\tpage\tcountry\tplan\n${tuple}\n`,
    visits: 'visits\ttuples\n1\t0\n',
  })
  const good = 'seen\t/\tmyapp.send\t\tPL\tpro'
  assertEquals(checkSummary(summary(good, 'seen\t/\tPL\tpro')), 1)
  const counts = [
    'click\t/\t\t\t\t',
    'seen\t\t\t\t\t',
    'seen\t/\t<b>.x\t\t\t',
    'outcome\t/\t\tsent\t\t',
    'seen\t/\t\t\tpl\t',
    'seen\t/\t\t\t\t<script>',
  ]
  for (const count of counts) {
    assertThrows(() => checkSummary(summary(count, 'seen\t/\tPL\tpro')), /line that is not valid/)
  }
  assertThrows(
    () => checkSummary(summary(good, 'seen\t/\tPL\ta b')),
    /line that is not valid/,
  )
  const page = 'page\t/\t\t\tPL\tpro'
  assertEquals(
    checkSummary(summary(page, 'page\t/\tPL\tpro', '2\t1690\t420\t1270\t420:1,1200:1')),
    2,
  )
  const readies = [
    '2\t1690\t420\t1270\t',
    '2\t1690\t420\t1270\t425:1,1200:1',
    '2\t1690\t420\t1270\t1200:1,420:1',
    '2\t1690\t420\t1270\t420:2,1200:1',
    '2\t1690\t420\t1270\t400:1,1200:1',
    '2\t9999\t420\t1270\t420:1,1200:1',
    '2\t1690\t420\t5000000\t420:1,5000000:1',
  ]
  for (const ready of readies) {
    assertThrows(
      () => checkSummary(summary(page, 'page\t/\tPL\tpro', ready)),
      /line that is not valid/,
    )
  }
})
