import { isSummaryOnlyDay, readGenerations, sealDay, writeSummaryDay } from '../src/column-store.js'
import { countBackup, createBackupStream, restoreBackup } from '../src/backup.js'
import { parseQuery } from '../src/query-core.js'
import { applySegment } from '../src/storage.js'
import { tarEnd, tarEntry } from '../src/tar.js'
import { assert, assertEquals, assertRejects, temporaryDir } from './assert.js'
import { ask, DAYS, fill, openFile, saveStream } from './fixtures.js'

const NOW = Date.parse('2026-10-01T12:00:00Z')

const encoder = new TextEncoder()

const sealedCopy = async () => {
  const dataDir = await fill()
  for (const day of DAYS) await sealDay(`${dataDir}/apps/myapp/${day}`)
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
    segment: 9,
    text: `${JSON.stringify(['other', '2026-10-01', today])}\n`,
  })
  assertEquals(await countBackup(createBackupStream({ dataDir })), { apps: 1, days: 2 })
  assertEquals(await countBackup(createBackupStream({ dataDir, from: DAYS[1] })), {
    apps: 1,
    days: 1,
  })
  assertEquals(await countBackup(createBackupStream({ dataDir, app: 'other' })), {
    apps: 0,
    days: 0,
  })
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a restore skips the days that the server stores or has not sealed', async () => {
  const dataDir = await sealedCopy()
  const file = `${dataDir}/backup.tar.gz`
  await saveStream(createBackupStream({ dataDir }), file)
  const again = await restoreBackup({ dataDir, open: openFile(file), now: NOW, sealDelayMs: 0 })
  assertEquals(again.restored, [])
  assertEquals(again.skipped.map((entry) => entry.reason), [
    'the server already stores the day',
    'the server already stores the day',
  ])
  const otherDir = await temporaryDir()
  const early = await restoreBackup({
    dataDir: otherDir,
    open: openFile(file),
    now: Date.parse('2026-09-22T00:30:00Z'),
    sealDelayMs: 4_200_000,
  })
  assertEquals(early.restored, [{ app: 'myapp', day: DAYS[0] }])
  assertEquals(early.skipped, [{ app: 'myapp', day: DAYS[1], reason: 'the day is not sealed yet' }])
  assert(await isSummaryOnlyDay(`${otherDir}/apps/myapp/${DAYS[0]}`))
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
      /x.txt is not a daily summary/,
    ],
    [
      [
        withoutEnd,
        ...tarEntry({
          name: 'myapp/2026-09-01/summary-counts.tsv',
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
            name: `myapp/2026-09-02/${name}`,
            data: encoder.encode('bad\theader\n'),
            mtimeMs: 0,
          }),
        ]),
        tarEnd(),
      ],
      'gzip',
      /header that is not valid/,
    ],
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
  const path = `${dataDir}/apps/myapp/2026-09-01`
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
  assertEquals(await applySegment({ dataDir, segment: 1, text }), 0)
  assertEquals((await readGenerations(path)).raws, [])
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a query skips a damaged day, counts the others and names the problem', async () => {
  const dataDir = await sealedCopy()
  const query = (fields) =>
    parseQuery({ app: 'myapp', from: '2026-09-01', to: DAYS[1], ...fields }, NOW)
  const full = await ask(dataDir, query({}))
  const sealed = `${dataDir}/apps/myapp/${DAYS[0]}/sealed-1`
  await Deno.remove(`${sealed}/summary-counts.tsv`)
  await Deno.remove(`${sealed}/visit.rle`)
  const summary = await ask(dataDir, query({}))
  assertEquals(summary.days, 2)
  assertEquals(summary.skippedDays.length, 1)
  assertEquals(summary.skippedDays[0].day, DAYS[0])
  assert(/summary-counts.tsv/.test(summary.skippedDays[0].reason))
  assertEquals(summary.rows[0].records, full.rows[0].records / 2)
  const scan = await ask(dataDir, query({ groupBy: ['visit'] }))
  assertEquals(scan.skippedDays.map((entry) => entry.day), [DAYS[0]])
  assert(/visit.rle/.test(scan.skippedDays[0].reason))
  await Deno.remove(dataDir, { recursive: true })
})
