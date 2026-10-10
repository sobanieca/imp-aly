import { readDaySummary, sealDay, SUMMARY_ONLY_PROBLEM } from '../src/column-store.js'
import { createBackupStream, restoreBackup, summaryEntries } from '../src/backup.js'
import { DAY_MS, dayOf, isPeriodId, periodDays } from '../src/days.js'
import { periodDir, periodSourceDir } from '../src/periods.js'
import { canUseSummary, finalizeQuery, parseQuery } from '../src/query-core.js'
import { runQuery } from '../src/query.js'
import { checkSummary, createSummaryMerger, forEachVisitLine } from '../src/summary.js'
import { applySegment, sealDuePeriods } from '../src/storage.js'
import { tarEnd } from '../src/tar.js'
import { assert, assertEquals, assertThrows, temporaryDir } from './assert.js'
import {
  ask,
  dayPath,
  DAYS,
  fill,
  openFile,
  OTHER_SOURCE,
  saveStream,
  sealAll,
  SOURCE,
} from './fixtures.js'

const QUERIES = [
  { measures: ['records', 'visits'] },
  { groupBy: ['day'], measures: ['visits', 'records'] },
  { groupBy: ['page', 'type'], measures: ['records', 'visits'] },
  { where: { type: 'page' }, groupBy: ['week', 'page'], measures: ['visits', 'records'] },
  { groupBy: ['month'], measures: ['visits', 'records'] },
  { groupBy: ['country', 'week'], measures: ['visits'] },
  { where: { type: ['seen', 'used'] }, groupBy: ['zone', 'type', 'month'] },
  { where: { type: ['page', 'used'], zone: null }, groupBy: ['page', 'type', 'week'] },
  { where: { type: 'outcome', page: '/invoices/:id' }, groupBy: ['name'] },
  { where: { country: 'PL', plan: 'pro' }, groupBy: ['day'], measures: ['records', 'visits'] },
  { where: { plan: null }, groupBy: ['country', 'plan'], measures: ['visits'] },
  { groupBy: ['plan', 'country', 'day'], measures: ['visits', 'records'] },
  { where: { zone: 'myapp.zone-1' }, measures: ['visits'] },
  { groupBy: ['visit'], measures: ['records'], limit: 5 },
]

const NOW = Date.parse('2026-10-01T12:00:00Z')

const visitNumber = (visit) => Number(visit.slice(1))

Deno.test('summaries answer every query exactly like a scan', async () => {
  const dataDir = await fill()
  const queries = QUERIES.map((fields) =>
    parseQuery({ app: 'myapp', from: DAYS[0], to: DAYS[1], ...fields }, NOW)
  )
  const scanned = []
  for (const query of queries) scanned.push(await ask(dataDir, query))
  await sealAll(dataDir)
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
  const allDir = await fill()
  const evenDir = await fill({ keep: (visit) => visitNumber(visit) % 2 === 0 })
  const oddDir = await fill({ keep: (visit) => visitNumber(visit) % 2 === 1 })
  await sealDay(dayPath(evenDir, DAYS[0]))
  await sealAll(allDir)
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
  await sealAll(dataDir)
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
        DAYS.map((day) => ({ server: 'local', day, source: SOURCE, reason: SUMMARY_ONLY_PROBLEM })),
      )
      assertEquals(result.scanned, 0, `query ${index}`)
    }
  }
  await Deno.remove(dataDir, { recursive: true })
  await Deno.remove(restoredDir, { recursive: true })
})

const twoServers = async () => {
  const evenDir = await fill({ keep: (visit) => visitNumber(visit) % 2 === 0 })
  const oddDir = await fill({ keep: (visit) => visitNumber(visit) % 2 === 1, source: OTHER_SOURCE })
  await sealAll(evenDir)
  await sealAll(oddDir, OTHER_SOURCE)
  const backups = []
  for (const dataDir of [evenDir, oddDir]) {
    const file = `${dataDir}/backup.tar.gz`
    await saveStream(createBackupStream({ dataDir }), file)
    backups.push(file)
  }
  return { evenDir, oddDir, backups }
}

const answerOf = async (server, dataDir, query) => ({
  server,
  answer: JSON.parse(JSON.stringify(await runQuery({ dataDir, query }))),
})

const restore = (dataDir, file) =>
  restoreBackup({ dataDir, open: openFile(file), now: NOW, sealDelayMs: 0 })

const withoutServers = (result) => ({ ...result, servers: [] })

Deno.test('the backups of two servers restore into a third, which answers like the two', async () => {
  const { evenDir, oddDir, backups } = await twoServers()
  const thirdDir = await temporaryDir()
  for (const file of backups) assertEquals((await restore(thirdDir, file)).restored.length, 2)
  const answers = async () => {
    const results = []
    for (const fields of QUERIES) {
      const query = parseQuery({ app: 'myapp', from: DAYS[0], to: DAYS[1], ...fields }, NOW)
      results.push(await ask(thirdDir, query))
    }
    return results
  }
  const once = await answers()
  for (const [index, fields] of QUERIES.entries()) {
    const query = parseQuery({ app: 'myapp', from: DAYS[0], to: DAYS[1], ...fields }, NOW)
    const two = finalizeQuery(query, [
      await answerOf('even', evenDir, query),
      await answerOf('odd', oddDir, query),
    ])
    const result = once[index]
    if (canUseSummary(query)) {
      assertEquals(withoutServers(result), withoutServers(two), `query ${index}`)
      assertEquals(result.servers[0].summaryDays, 2)
    } else {
      assertEquals(
        result.skippedDays.map((entry) => `${entry.day} ${entry.source}`),
        DAYS.flatMap((day) => [`${day} ${SOURCE}`, `${day} ${OTHER_SOURCE}`]),
      )
      assertEquals(result.scanned, 0, `query ${index}`)
    }
  }
  for (const file of backups) {
    const again = await restore(thirdDir, file)
    assertEquals(again.restored, [])
    assertEquals(again.skipped.length, 2)
  }
  assertEquals(await answers(), once)
  for (const dataDir of [evenDir, oddDir, thirdDir]) await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a backup of server B restores into server A, which stores the same days', async () => {
  const { evenDir, oddDir, backups } = await twoServers()
  const serverA = await fill({ keep: (visit) => visitNumber(visit) % 2 === 0 })
  await sealDay(dayPath(serverA, DAYS[0]))
  const expected = []
  for (const fields of QUERIES) {
    const query = parseQuery({ app: 'myapp', from: DAYS[0], to: DAYS[1], ...fields }, NOW)
    expected.push({
      query,
      alone: await answerOf('a', serverA, query),
      two: finalizeQuery(query, [
        await answerOf('a', serverA, query),
        await answerOf('b', oddDir, query),
      ]),
    })
  }
  const restored = await restore(serverA, backups[1])
  assertEquals(restored.restored, DAYS.map((day) => ({ app: 'myapp', source: OTHER_SOURCE, day })))
  for (const [index, { query, alone, two }] of expected.entries()) {
    const result = await ask(serverA, query)
    if (canUseSummary(query)) {
      assertEquals(withoutServers(result), withoutServers(two), `query ${index}`)
      assertEquals(result.servers[0].summaryDays, 1)
    } else {
      assertEquals(result.skippedDays.map((entry) => entry.source), [OTHER_SOURCE, OTHER_SOURCE])
      assertEquals(
        { ...withoutServers(result), skippedDays: [] },
        withoutServers(finalizeQuery(query, [alone])),
        `query ${index}`,
      )
    }
  }
  for (const dataDir of [evenDir, oddDir, serverA]) await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a day with late records is scanned', async () => {
  const dataDir = await fill()
  const path = dayPath(dataDir, DAYS[0])
  await sealDay(path)
  const late = { type: 'error', visit: 'late', at: Date.parse(DAYS[0]), page: '/' }
  await applySegment({
    dataDir,
    source: SOURCE,
    segment: 2,
    text: `${JSON.stringify(['myapp', DAYS[0], late])}\n`,
  })
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
  const summary = (count, tuple, records = '1') => ({
    counts: `type\tpage\tzone\tname\tcountry\tplan\trecords\n${count}\t${records}\n`,
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
    'seen\tinvoices\t\t\t\t',
    `seen\t/${'x'.repeat(512)}\t\t\t\t`,
  ]
  for (const count of counts) {
    assertThrows(() => checkSummary(summary(count, 'seen\t/\tPL\tpro')), /line that is not valid/)
  }
  assertThrows(
    () => checkSummary(summary(good, 'seen\t/\tPL\ta b')),
    /line that is not valid/,
  )
  assertThrows(
    () => checkSummary(summary(good, 'seen\tno-slash\tPL\tpro')),
    /line that is not valid/,
  )
  assertEquals(checkSummary(summary('seen\t/invoices/:id\t\t\t\t', 'seen\t/\tPL\tpro')), 1)
  const page = 'page\t/\t\t\tPL\tpro'
  assertEquals(checkSummary(summary(page, 'page\t/\tPL\tpro', '2')), 2)
  for (const records of ['0', '-1', '1.5', '01', '', '2\t420']) {
    assertThrows(
      () => checkSummary(summary(page, 'page\t/\tPL\tpro', records)),
      /line that is not valid/,
    )
  }
})

const daysBetween = (first, last) => {
  const days = []
  for (let time = Date.parse(first); time <= Date.parse(last); time += DAY_MS) {
    days.push(dayOf(time))
  }
  return days
}

const PERIOD_DAYS = daysBetween('2026-08-29', '2026-10-04').filter((day) => day !== '2026-09-09')

const PERIOD_NOW = Date.parse('2026-10-08T12:00:00Z')

const PERIOD_RANGE = { from: '2026-08-28', to: '2026-10-05' }

const PERIOD_QUERIES = [
  ...QUERIES,
  { groupBy: ['week'], measures: ['visits', 'records'] },
  { where: { type: 'page' }, groupBy: ['month', 'plan'], measures: ['visits'] },
]

const periodQuery = (fields, range = PERIOD_RANGE) =>
  parseQuery({ app: 'myapp', ...range, ...fields }, PERIOD_NOW)

const sealedPeriods = async (options = {}) => {
  const source = options.source ?? SOURCE
  const dataDir = await fill({ days: PERIOD_DAYS, ...options })
  await sealAll(dataDir, source, PERIOD_DAYS)
  return dataDir
}

const buildPeriods = (dataDir, source = SOURCE, checked = new Set()) =>
  sealDuePeriods({ dataDir, source, now: PERIOD_NOW, sealDelayMs: 0, checked })

Deno.test('week and month summaries answer every query exactly like the days', async () => {
  const dataDir = await sealedPeriods()
  const queries = PERIOD_QUERIES.map((fields) => periodQuery(fields))
  const fromDays = []
  for (const query of queries) fromDays.push(await ask(dataDir, query))
  const built = await buildPeriods(dataDir)
  assertEquals(built, [
    'myapp/weeks/2026-08-24',
    'myapp/months/2026-08',
    'myapp/weeks/2026-08-31',
    'myapp/months/2026-09',
    'myapp/weeks/2026-09-07',
    'myapp/weeks/2026-09-14',
    'myapp/weeks/2026-09-21',
    'myapp/weeks/2026-09-28',
  ])
  assertEquals(await buildPeriods(dataDir), [])
  for (const [index, query] of queries.entries()) {
    assertEquals(await ask(dataDir, query), fromDays[index], `query ${index}`)
  }
  await Deno.remove(`${dayPath(dataDir, '2026-09-15')}/sealed-1/summary-counts.tsv`)
  for (const [index, fields] of PERIOD_QUERIES.entries()) {
    const query = periodQuery(fields)
    const result = await ask(dataDir, query)
    if (query.groupBy.includes('day') || !canUseSummary(query)) continue
    assertEquals(result, fromDays[index], `query ${index} without the daily summary`)
  }
  const byDay = await ask(dataDir, periodQuery({ groupBy: ['day'] }))
  assertEquals(byDay.skippedDays.map((entry) => entry.day), ['2026-09-15'])
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a day with late records is read from the days until the period is made again', async () => {
  const dataDir = await sealedPeriods()
  const checked = new Set()
  await buildPeriods(dataDir, SOURCE, checked)
  const query = periodQuery({ groupBy: ['month'], measures: ['records', 'visits'] })
  const before = await ask(dataDir, query)
  const late = { type: 'error', visit: 'late', at: Date.parse('2026-09-15'), page: '/' }
  await applySegment({
    dataDir,
    source: SOURCE,
    segment: 2,
    text: `${JSON.stringify(['myapp', '2026-09-15', late])}\n`,
  })
  const withLate = await ask(dataDir, query)
  const september = (result) => result.rows.find((row) => row.month === '2026-09')
  assertEquals(september(withLate).records, september(before).records + 1)
  assertEquals(september(withLate).visits, september(before).visits + 1)
  assertEquals(withLate.servers[0].summaryDays, PERIOD_DAYS.length - 1)
  await sealDay(dayPath(dataDir, '2026-09-15'))
  assertEquals(await buildPeriods(dataDir, SOURCE, checked), [])
  checked.delete('myapp/weeks/2026-09-14')
  checked.delete('myapp/months/2026-09')
  assertEquals(await buildPeriods(dataDir, SOURCE, checked), [
    'myapp/months/2026-09',
    'myapp/weeks/2026-09-14',
  ])
  await Deno.remove(`${dayPath(dataDir, '2026-09-15')}/sealed-2/summary-counts.tsv`)
  const after = await ask(dataDir, query)
  assertEquals(after.servers[0].summaryDays, PERIOD_DAYS.length)
  assertEquals(withoutServers(after), withoutServers(withLate))
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a server with the period summaries of two servers answers like the two', async () => {
  const allDir = await sealedPeriods()
  const evenDir = await sealedPeriods({ keep: (visit) => visitNumber(visit) % 2 === 0 })
  const oddDir = await sealedPeriods({
    keep: (visit) => visitNumber(visit) % 2 === 1,
    source: OTHER_SOURCE,
  })
  await buildPeriods(allDir)
  await buildPeriods(evenDir)
  await buildPeriods(oddDir, OTHER_SOURCE)
  const twoAnswers = []
  for (const fields of PERIOD_QUERIES) {
    const query = periodQuery(fields)
    twoAnswers.push(
      finalizeQuery(query, [
        await answerOf('even', evenDir, query),
        await answerOf('odd', oddDir, query),
      ]),
    )
  }
  const move = async (path) => {
    const target = path.replace(oddDir, evenDir)
    await Deno.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    await Deno.rename(path, target)
  }
  for (const day of PERIOD_DAYS) await move(dayPath(oddDir, day, OTHER_SOURCE))
  for (const kind of ['weeks', 'months']) {
    for await (const period of Deno.readDir(`${oddDir}/apps/myapp/${kind}`)) {
      await move(periodSourceDir(oddDir, 'myapp', kind, period.name, OTHER_SOURCE))
    }
  }
  for (const day of ['2026-09-15', '2026-09-22']) {
    for (const source of [SOURCE, OTHER_SOURCE]) {
      await Deno.remove(`${dayPath(evenDir, day, source)}/sealed-1/summary-counts.tsv`)
    }
  }
  for (const [index, fields] of PERIOD_QUERIES.entries()) {
    const query = periodQuery(fields)
    const one = await ask(allDir, query)
    assertEquals(withoutServers(twoAnswers[index]), withoutServers(one), `query ${index}`)
    if (!['week', 'month'].some((time) => query.groupBy.includes(time))) continue
    if (!canUseSummary(query)) continue
    const both = await ask(evenDir, query)
    assertEquals(withoutServers(both), withoutServers(one), `query ${index} of both sources`)
    assertEquals(both.servers[0].summaryDays, PERIOD_DAYS.length)
  }
  for (const dataDir of [allDir, evenDir, oddDir]) await Deno.remove(dataDir, { recursive: true })
})

const periodBackup = async (dataDir, periods) => {
  const chunks = []
  for (const [kind, id] of periods) {
    const summary = await readDaySummary(periodSourceDir(dataDir, 'myapp', kind, id, SOURCE), {
      withVisits: true,
    })
    chunks.push(
      ...summaryEntries({ app: 'myapp', source: SOURCE, kind, id, summary, mtimeMs: 0 }),
    )
  }
  chunks.push(tarEnd())
  const file = `${dataDir}/periods.tar.gz`
  await saveStream(ReadableStream.from(chunks).pipeThrough(new CompressionStream('gzip')), file)
  return file
}

Deno.test('a restored week or month with no days answers by its time, and other queries skip it', async () => {
  const dataDir = await sealedPeriods()
  await buildPeriods(dataDir)
  const file = await periodBackup(dataDir, [['weeks', '2026-09-14'], ['months', '2026-09']])
  const restoredDir = await temporaryDir()
  const restoreAt = (now) =>
    restoreBackup({ dataDir: restoredDir, open: openFile(file), now, sealDelayMs: 0 })
  const early = await restoreAt(Date.parse('2026-09-25T00:00:00Z'))
  assertEquals(early.restored, [{ app: 'myapp', source: SOURCE, week: '2026-09-14' }])
  assertEquals(early.skipped, [
    { app: 'myapp', source: SOURCE, month: '2026-09', reason: 'the month is not sealed yet' },
  ])
  await Deno.remove(periodDir(restoredDir, 'myapp', 'weeks', '2026-09-14'), { recursive: true })
  const restored = await restoreAt(PERIOD_NOW)
  assertEquals(restored.restored, [
    { app: 'myapp', source: SOURCE, week: '2026-09-14' },
    { app: 'myapp', source: SOURCE, month: '2026-09' },
  ])
  const week = { from: '2026-09-14', to: '2026-09-20' }
  const month = { from: '2026-09-01', to: '2026-09-30' }
  for (const [range, time] of [[week, 'week'], [month, 'month'], [week, null], [month, null]]) {
    for (const fields of PERIOD_QUERIES) {
      if (fields.groupBy?.some((field) => ['day', 'week', 'month'].includes(field))) continue
      const groupBy = [...(fields.groupBy ?? []), ...(time ? [time] : [])]
      const query = periodQuery({ ...fields, groupBy }, range)
      if (!canUseSummary(query)) continue
      assertEquals(
        await ask(restoredDir, query),
        await ask(dataDir, query),
        `${time} ${range.from}`,
      )
    }
  }
  const byDay = await ask(restoredDir, periodQuery({ groupBy: ['day'] }, week))
  assertEquals(byDay.rows, [])
  assertEquals(byDay.days, 7)
  assertEquals(
    byDay.skippedDays,
    daysBetween(week.from, week.to).map((day) => ({
      server: 'local',
      day,
      source: SOURCE,
      reason: 'only the summary of the week is stored',
    })),
  )
  const byWeek = await ask(restoredDir, periodQuery({ groupBy: ['week'] }, month))
  assertEquals(byWeek.rows.map((row) => row.week), ['2026-09-14'])
  assert(byWeek.skippedDays.every((entry) => entry.reason.includes('month')))
  assertEquals(byWeek.skippedDays.length, 29 - 7)
  const again = await restoreAt(PERIOD_NOW)
  assertEquals(again.restored, [])
  assertEquals(again.skipped.map((entry) => entry.reason), [
    'the server already stores the week of the source',
    'the server already stores the month of the source',
  ])
  await Deno.remove(dataDir, { recursive: true })
  await Deno.remove(restoredDir, { recursive: true })
})

const WEEKS = { from: '2026-08-24', to: '2026-10-04' }

const MONTHS = { from: '2026-08-01', to: '2026-09-30' }

const TIMES = [['week', WEEKS], ['month', MONTHS]]

const timeQueries = () =>
  TIMES.flatMap(([time, range]) =>
    PERIOD_QUERIES
      .filter((fields) =>
        !fields.groupBy?.some((field) => ['day', 'week', 'month'].includes(field))
      )
      .map((fields) =>
        periodQuery({ ...fields, groupBy: [...(fields.groupBy ?? []), time] }, range)
      )
      .filter((query) => canUseSummary(query))
  )

const backupBy = async (dataDir, by, name = by) => {
  const file = `${dataDir}/${name}.tar.gz`
  await saveStream(createBackupStream({ dataDir, by, now: PERIOD_NOW, sealDelayMs: 0 }), file)
  return file
}

const restorePeriods = (dataDir, file) =>
  restoreBackup({ dataDir, open: openFile(file), now: PERIOD_NOW, sealDelayMs: 0 })

const periodIds = (entries) =>
  entries.map((entry) => `${entry.week ?? entry.month} ${entry.source}`)

const BACKUP_WEEKS = [
  '2026-08-24',
  '2026-08-31',
  '2026-09-07',
  '2026-09-14',
  '2026-09-21',
  '2026-09-28',
]

Deno.test('a week and a month backup restores into an empty server, which answers like the first', async () => {
  const dataDir = await sealedPeriods()
  await buildPeriods(dataDir)
  const restoredDir = await temporaryDir()
  const files = [await backupBy(dataDir, 'week'), await backupBy(dataDir, 'month')]
  const [weeks, months] = [
    await restorePeriods(restoredDir, files[0]),
    await restorePeriods(restoredDir, files[1]),
  ]
  assertEquals(periodIds(weeks.restored), BACKUP_WEEKS.map((week) => `${week} ${SOURCE}`))
  assertEquals(periodIds(months.restored), [`2026-08 ${SOURCE}`, `2026-09 ${SOURCE}`])
  const answers = async (dir) => {
    const results = []
    for (const query of timeQueries()) results.push(await ask(dir, query))
    return results
  }
  const expected = await answers(dataDir)
  const once = await answers(restoredDir)
  for (const [index, result] of once.entries()) {
    assertEquals(result, expected[index], `query ${index}`)
  }
  for (const file of files) assertEquals((await restorePeriods(restoredDir, file)).restored, [])
  assertEquals(await answers(restoredDir), once)
  await Deno.remove(dataDir, { recursive: true })
  await Deno.remove(restoredDir, { recursive: true })
})

Deno.test('the week and month backups of two servers restore into a third, which answers like the two', async () => {
  const evenDir = await sealedPeriods({ keep: (visit) => visitNumber(visit) % 2 === 0 })
  const oddDir = await sealedPeriods({
    keep: (visit) => visitNumber(visit) % 2 === 1,
    source: OTHER_SOURCE,
  })
  await buildPeriods(evenDir)
  await buildPeriods(oddDir, OTHER_SOURCE)
  const thirdDir = await temporaryDir()
  const files = []
  for (const dataDir of [evenDir, oddDir]) {
    for (const by of ['week', 'month']) files.push(await backupBy(dataDir, by))
  }
  const restored = []
  for (const file of files) {
    const result = await restorePeriods(thirdDir, file)
    assertEquals(result.skipped, [])
    restored.push(...periodIds(result.restored))
  }
  assertEquals(restored.length, 2 * (BACKUP_WEEKS.length + 2))
  const answers = async () => {
    const results = []
    for (const query of timeQueries()) results.push(await ask(thirdDir, query))
    return results
  }
  const once = await answers()
  for (const [index, query] of timeQueries().entries()) {
    const two = finalizeQuery(query, [
      await answerOf('even', evenDir, query),
      await answerOf('odd', oddDir, query),
    ])
    assertEquals(withoutServers(once[index]), withoutServers(two), `query ${index}`)
    assertEquals(once[index].skippedDays, [])
  }
  for (const file of files) assertEquals((await restorePeriods(thirdDir, file)).restored, [])
  assertEquals(await answers(), once)
  for (const dataDir of [evenDir, oddDir, thirdDir]) await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a week or a month backup leaves out a source with no stored week or month summary', async () => {
  const serverA = await sealedPeriods({ keep: (visit) => visitNumber(visit) % 2 === 0 })
  const serverB = await sealedPeriods({
    keep: (visit) => visitNumber(visit) % 2 === 1,
    source: OTHER_SOURCE,
  })
  await buildPeriods(serverA)
  const days = await backupBy(serverB, 'day')
  assertEquals((await restorePeriods(serverA, days)).restored.length, PERIOD_DAYS.length)
  const weeks = await restorePeriods(await temporaryDir(), await backupBy(serverA, 'week'))
  assertEquals(periodIds(weeks.restored), BACKUP_WEEKS.map((week) => `${week} ${SOURCE}`))
  const months = await restorePeriods(await temporaryDir(), await backupBy(serverA, 'month'))
  assertEquals(periodIds(months.restored), [`2026-08 ${SOURCE}`, `2026-09 ${SOURCE}`])
  for (const dataDir of [serverA, serverB]) await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a week or a month backup holds only the complete periods inside the period', async () => {
  const dataDir = await sealedPeriods()
  await buildPeriods(dataDir)
  const ids = async (by, last, now = PERIOD_NOW) => {
    const restoredDir = await temporaryDir()
    const file = `${dataDir}/${by}-${last}.tar.gz`
    await saveStream(createBackupStream({ dataDir, by, last, now, sealDelayMs: 0 }), file)
    const { restored } = await restoreBackup({
      dataDir: restoredDir,
      open: openFile(file),
      now: PERIOD_NOW,
      sealDelayMs: 0,
    })
    await Deno.remove(restoredDir, { recursive: true })
    return restored.map((entry) => entry.week ?? entry.month)
  }
  assertEquals(await ids('week', '30d'), ['2026-09-14', '2026-09-21', '2026-09-28'])
  assertEquals(await ids('week', '7d'), [])
  assertEquals(await ids('week', '7d', Date.parse('2026-10-05T00:00:00Z')), ['2026-09-28'])
  assertEquals(await ids('week', '1d', Date.parse('2026-10-05T00:00:00Z')), [])
  assertEquals(await ids('month', '30d'), [])
  assertEquals(await ids('month', '3m'), ['2026-08', '2026-09'])
  assertEquals(await ids('month', '30d', Date.parse('2026-10-01T00:00:00Z')), ['2026-09'])
  assertEquals(await ids('month', 'all', Date.parse('2026-09-30T23:59:00Z')), ['2026-08'])
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a week starts on Monday, and a month has all its days', () => {
  assertEquals(periodDays('weeks', '2026-09-28'), daysBetween('2026-09-28', '2026-10-04'))
  assertEquals(periodDays('months', '2026-02').length, 28)
  assertEquals(periodDays('months', '2028-02').at(-1), '2028-02-29')
  assertEquals(isPeriodId('weeks', '2026-09-28'), true)
  assertEquals(isPeriodId('weeks', '2026-09-29'), false)
  assertEquals(isPeriodId('months', '2026-09'), true)
  assertEquals(isPeriodId('months', '2026-13'), false)
})

Deno.test('the merge of daily summaries adds the counts and keeps each visit of a day', () => {
  const merger = createSummaryMerger()
  merger.add({
    counts: 'type\tpage\tzone\tname\tcountry\tplan\trecords\npage\t/\t\t\tPL\tpro\t3\n',
    tuples: 'type\tpage\tcountry\tplan\npage\t/\tPL\tpro\n',
    visits: 'visits\ttuples\n2\t0\n',
  })
  merger.add({
    counts: 'type\tpage\tzone\tname\tcountry\trole\trecords\n' +
      'page\t/\t\t\tPL\t\t1\npage\t/\t\t\tPL\tadmin\t4\n',
    tuples: 'type\tpage\tcountry\trole\npage\t/\tPL\tadmin\npage\t/\tPL\t\n',
    visits: 'visits\ttuples\n1\t0,1\n1\t1\n',
  })
  merger.add({
    counts: 'type\tpage\tzone\tname\tcountry\tplan\trecords\npage\t/\t\t\tPL\tpro\t2\n',
    tuples: 'type\tpage\tcountry\tplan\npage\t/\tPL\tpro\n',
    visits: 'visits\ttuples\n1\t0\n',
  })
  const { rows, files } = merger.finish()
  assertEquals(rows, 10)
  const text = {
    counts: files.counts.join(''),
    tuples: files.tuples.join(''),
    visits: files.visits.join(''),
  }
  assertEquals(text, {
    counts: 'type\tpage\tzone\tname\tcountry\tplan\trole\trecords\n' +
      'page\t/\t\t\tPL\tpro\t\t5\npage\t/\t\t\tPL\t\t\t1\npage\t/\t\t\tPL\t\tadmin\t4\n',
    tuples: 'type\tpage\tcountry\tplan\trole\npage\t/\tPL\tpro\t\npage\t/\tPL\t\tadmin\n' +
      'page\t/\tPL\t\t\n',
    visits: 'visits\ttuples\n3\t0\n1\t1,2\n1\t2\n',
  })
  assertEquals(checkSummary(text), 10)
})

Deno.test('a visit line without a tab fails and does not loop', () => {
  for (const text of ['visits\ttuples\n5', 'visits\ttuples\n5\n']) {
    assertThrows(() => forEachVisitLine(text, () => {}), /visit line is not valid/)
  }
})
