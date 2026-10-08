import { isSummaryOnlyDay, readGenerations, writeSummaryDay } from '../src/column-store.js'
import {
  backupRange,
  countBackup,
  createBackupStream,
  parseBackupOptions,
  restoreBackup,
} from '../src/backup.js'
import { parseQuery } from '../src/query-core.js'
import { DEFAULT_SEAL_DELAY_MS } from '../src/records.js'
import { applySegment, sealDuePeriods } from '../src/storage.js'
import { tarEnd, tarEntry } from '../src/tar.js'
import { assert, assertEquals, assertRejects, assertThrows, temporaryDir } from './assert.js'
import { ask, dayPath, DAYS, fill, openFile, saveStream, sealAll, SOURCE } from './fixtures.js'

const NOW = Date.parse('2026-10-01T12:00:00Z')

const encoder = new TextEncoder()

const sealedCopy = async () => {
  const dataDir = await fill()
  await sealAll(dataDir)
  return dataDir
}

const gzip = (chunks) => ReadableStream.from(chunks).pipeThrough(new CompressionStream('gzip'))

const listDays = async (dataDir) => {
  const days = []
  try {
    for await (const app of Deno.readDir(`${dataDir}/apps`)) {
      for await (const day of Deno.readDir(`${dataDir}/apps/${app.name}`)) {
        days.push(`${app.name}/${day.name}`)
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  return days.sort()
}

Deno.test('a backup holds the sealed days of the range', async () => {
  const dataDir = await sealedCopy()
  const today = { type: 'error', visit: 'v', at: NOW, page: '/' }
  await applySegment({
    dataDir,
    source: SOURCE,
    segment: 9,
    text: `${JSON.stringify(['other', '2026-10-01', today])}\n`,
  })
  const count = (options) => countBackup(createBackupStream({ dataDir, now: NOW, ...options }))
  const counts = (days) => ({
    apps: days ? 1 : 0,
    sources: days ? 1 : 0,
    days,
    weeks: 0,
    months: 0,
  })
  assertEquals(await count({}), counts(2))
  assertEquals(await count({ last: '1d', now: Date.parse('2026-09-22T12:00:00Z') }), counts(1))
  assertEquals(await count({ last: '7d', now: Date.parse('2026-09-22T01:00:00Z') }), counts(1))
  assertEquals(await count({ last: '7d', now: Date.parse('2026-09-22T01:20:00Z') }), counts(2))
  assertEquals(await count({ last: '1d', now: Date.parse('2026-09-23T12:00:00Z') }), counts(0))
  assertEquals(await count({ by: 'week' }), counts(0))
  await sealDuePeriods({ dataDir, source: SOURCE, now: NOW, sealDelayMs: DEFAULT_SEAL_DELAY_MS })
  assertEquals(await count({ by: 'week' }), { ...counts(0), apps: 1, sources: 1, weeks: 2 })
  const lastWeek = { by: 'week', last: '7d', now: Date.parse('2026-09-28T12:00:00Z') }
  assertEquals(await count(lastWeek), { ...counts(0), apps: 1, sources: 1, weeks: 1 })
  assertEquals(await count({ by: 'month' }), { ...counts(0), apps: 1, sources: 1, months: 1 })
  assertEquals(await count({ by: 'month', now: Date.parse('2026-09-30T12:00:00Z') }), counts(0))
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('the backup options name a period that ends at the last sealed day', () => {
  const parse = (search) => parseBackupOptions(new URLSearchParams(search))
  assertEquals(parse(''), { last: 'all', by: 'day' })
  assertEquals(parse('last=3m&by=week'), { last: '3m', by: 'week' })
  for (const search of ['last=2d', 'by=year', 'app=myapp', 'from=2026-09-01']) {
    assertThrows(() => parse(search), /last|by/)
  }
  const range = (last, now) => backupRange({ last, now: Date.parse(now), sealDelayMs: 4_200_000 })
  assertEquals(range('1d', '2026-10-08T01:10:00Z'), { from: '2026-10-07', to: '2026-10-07' })
  assertEquals(range('1d', '2026-10-08T01:09:00Z'), { from: '2026-10-06', to: '2026-10-06' })
  assertEquals(range('7d', '2026-10-08T12:00:00Z'), { from: '2026-10-01', to: '2026-10-07' })
  assertEquals(range('30d', '2026-10-08T12:00:00Z'), { from: '2026-09-08', to: '2026-10-07' })
  assertEquals(range('3m', '2026-10-08T12:00:00Z'), { from: '2026-07-08', to: '2026-10-07' })
  assertEquals(range('6m', '2026-09-01T12:00:00Z'), { from: '2026-03-01', to: '2026-08-31' })
  assertEquals(range('1y', '2028-03-01T12:00:00Z'), { from: '2027-03-01', to: '2028-02-29' })
  assertEquals(range('all', '2026-10-08T12:00:00Z'), { from: null, to: '2026-10-07' })
})

Deno.test('a restore skips the days that the server stores or has not sealed', async () => {
  const dataDir = await sealedCopy()
  const file = `${dataDir}/backup.tar.gz`
  await saveStream(createBackupStream({ dataDir }), file)
  const again = await restoreBackup({ dataDir, open: openFile(file), now: NOW, sealDelayMs: 0 })
  assertEquals(again.restored, [])
  assertEquals(again.skipped.map((entry) => entry.reason), [
    'the server already stores the day of the source',
    'the server already stores the day of the source',
  ])
  const otherDir = await temporaryDir()
  const early = await restoreBackup({
    dataDir: otherDir,
    open: openFile(file),
    now: Date.parse('2026-09-22T00:30:00Z'),
    sealDelayMs: 4_200_000,
  })
  assertEquals(early.restored, [{ app: 'myapp', source: SOURCE, day: DAYS[0] }])
  assertEquals(early.skipped, [
    { app: 'myapp', source: SOURCE, day: DAYS[1], reason: 'the day is not sealed yet' },
  ])
  assert(await isSummaryOnlyDay(dayPath(otherDir, DAYS[0])))
  await Deno.remove(dataDir, { recursive: true })
  await Deno.remove(otherDir, { recursive: true })
})

Deno.test('a damaged backup restores nothing', async () => {
  const dataDir = await sealedCopy()
  const file = `${dataDir}/backup.tar.gz`
  await saveStream(createBackupStream({ dataDir }), file)
  const good = []
  for await (const chunk of (await openFile(file)()).pipeThrough(new DecompressionStream('gzip'))) {
    good.push(chunk)
  }
  const goodTar = new Uint8Array(await new Blob(good).arrayBuffer())
  const withoutEnd = goodTar.subarray(0, goodTar.length - 1024)
  const cases = [
    [[encoder.encode('not a gzip file')], null, /not valid/],
    [
      [withoutEnd, ...tarEntry({ name: 'x.txt', data: encoder.encode('x'), mtimeMs: 0 })],
      'gzip',
      /x.txt is not a summary file/,
    ],
    ...['myapp/2026-09-01/summary-counts.tsv', 'myapp/0123/days/2026-09-01/summary-counts.tsv']
      .map((name) => [
        [withoutEnd, ...tarEntry({ name, data: encoder.encode('x'), mtimeMs: 0 }), tarEnd()],
        'gzip',
        /is not a summary file of an app and a source/,
      ]),
    [
      [
        withoutEnd,
        ...tarEntry({
          name: `myapp/${SOURCE}/days/2026-09-01/summary-counts.tsv`,
          data: encoder.encode('type\tpage\n'),
          mtimeMs: 0,
        }),
        tarEnd(),
      ],
      'gzip',
      /2026-09-01 has no summary-tuples.tsv/,
    ],
    [
      [
        withoutEnd,
        ...['summary-counts.tsv', 'summary-tuples.tsv', 'summary-visits.tsv'].flatMap((name) => [
          ...tarEntry({
            name: `myapp/${SOURCE}/days/2026-09-02/${name}`,
            data: encoder.encode('bad\theader\n'),
            mtimeMs: 0,
          }),
        ]),
        tarEnd(),
      ],
      'gzip',
      /header that is not valid/,
    ],
    ...[
      ['2026-09-14', '2026-09-14\t1', /summary-days.tsv does not match the counts/],
      ['2026-09-14', '2026-09-21\t2', /summary-days.tsv has a line that is not valid/],
      ['2026-09-15', '2026-09-15\t2', /is not a summary file of an app and a source/],
    ].map(([week, line, pattern]) => [
      [
        withoutEnd,
        ...Object.entries({
          'summary-counts.tsv': 'type\tpage\tzone\tname\tcountry\trecords\nerror\t/\t\t\t\t2\n',
          'summary-tuples.tsv': 'type\tpage\tcountry\nerror\t/\t\n',
          'summary-visits.tsv': 'visits\ttuples\n1\t0\n',
          'summary-days.tsv': `day\trecords\n${line}\n`,
        }).flatMap(([name, text]) => [
          ...tarEntry({
            name: `myapp/${SOURCE}/weeks/${week}/${name}`,
            data: encoder.encode(text),
            mtimeMs: 0,
          }),
        ]),
        tarEnd(),
      ],
      'gzip',
      pattern,
    ]),
  ]
  for (const [chunks, kind, pattern] of cases) {
    const otherDir = await temporaryDir()
    const open = () => Promise.resolve(kind ? gzip(chunks) : ReadableStream.from(chunks))
    await assertRejects(
      () => restoreBackup({ dataDir: otherDir, open, now: NOW, sealDelayMs: 0 }),
      pattern,
    )
    assertEquals(await listDays(otherDir), [])
    await Deno.remove(otherDir, { recursive: true })
  }
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('records for a restored day are dropped', async () => {
  const dataDir = await temporaryDir()
  const path = dayPath(dataDir, '2026-09-01')
  await writeSummaryDay(path, {
    rows: 0,
    files: {
      counts: 'type\tpage\tzone\tname\tcountry\trecords\n',
      tuples: 'type\tpage\tcountry\n',
      visits: 'visits\ttuples\n',
    },
  })
  const record = { type: 'error', visit: 'v', at: Date.parse('2026-09-01'), page: '/' }
  const text = `${JSON.stringify(['myapp', '2026-09-01', record])}\n`
  assertEquals(await applySegment({ dataDir, source: SOURCE, segment: 1, text }), 0)
  assertEquals((await readGenerations(path)).raws, [])
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a query skips a damaged day, counts the others and names the problem', async () => {
  const dataDir = await sealedCopy()
  const query = (fields) =>
    parseQuery({ app: 'myapp', from: '2026-09-01', to: DAYS[1], ...fields }, NOW)
  const full = await ask(dataDir, query({}))
  const sealed = `${dayPath(dataDir, DAYS[0])}/sealed-1`
  await Deno.remove(`${sealed}/summary-counts.tsv`)
  await Deno.remove(`${sealed}/visit.rle`)
  const summary = await ask(dataDir, query({}))
  assertEquals(summary.days, 2)
  assertEquals(summary.skippedDays.length, 1)
  assertEquals(summary.skippedDays[0].day, DAYS[0])
  assertEquals(summary.skippedDays[0].source, SOURCE)
  assert(/summary-counts.tsv/.test(summary.skippedDays[0].reason))
  assertEquals(summary.rows[0].records, full.rows[0].records / 2)
  const scan = await ask(dataDir, query({ groupBy: ['visit'] }))
  assertEquals(scan.skippedDays.map((entry) => entry.day), [DAYS[0]])
  assert(/visit.rle/.test(scan.skippedDays[0].reason))
  await Deno.remove(dataDir, { recursive: true })
})
