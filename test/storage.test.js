import { readDay, readGenerations } from '../src/column-store.js'
import {
  applySegment,
  createStorage,
  listHeldDays,
  parseSegment,
  sealDueDays,
} from '../src/storage.js'
import { listClosedSegments, openWal, segmentFileName } from '../src/wal.js'
import { assert, assertEquals, temporaryDir, waitFor } from './assert.js'
import { dayPath, OTHER_SOURCE, SOURCE } from './fixtures.js'

const line = (app, day, record) => `${JSON.stringify([app, day, record])}\n`

Deno.test('a segment groups records by app and day and skips bad lines', () => {
  const text = line('a', '2026-10-01', { type: 'error', visit: 'v', at: 1, page: '/' }) +
    '{"torn' + '\n' +
    line('../x', '2026-10-01', {}) +
    line('a', '2026-13-01', {}) +
    line('a', '2026-10-01', { type: 'error', 'bad/key': 'x', visit: 'w', at: 2, page: '/' }) +
    line('b', '2026-10-02', { type: 'error', visit: 'v', at: 1, page: '/' })
  const groups = parseSegment(text)
  assertEquals(groups.map((group) => [group.app, group.day, group.records.length]), [
    ['a', '2026-10-01', 2],
    ['b', '2026-10-02', 1],
  ])
  assertEquals(Object.keys(groups[0].records[1]), ['type', 'visit', 'at', 'page'])
})

Deno.test('applying a segment twice stores it once', async () => {
  const dataDir = await temporaryDir()
  const text = line('a', '2026-10-01', { type: 'error', visit: 'v', at: 1, page: '/' })
  assertEquals(await applySegment({ dataDir, source: SOURCE, segment: 1, text }), 1)
  assertEquals(await applySegment({ dataDir, source: SOURCE, segment: 1, text }), 0)
  assertEquals((await readDay(dayPath(dataDir, '2026-10-01', SOURCE, 'a'), ['visit'])).rows, 1)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('days are sealed only after the delay', async () => {
  const dataDir = await temporaryDir()
  const text = line('a', '2026-10-01', { type: 'error', visit: 'v', at: 1, page: '/' })
  await applySegment({ dataDir, source: SOURCE, segment: 1, text })
  const dayEnd = Date.parse('2026-10-02')
  assertEquals(
    await sealDueDays({ dataDir, source: SOURCE, now: dayEnd + 10, sealDelayMs: 60_000 }),
    [],
  )
  assertEquals(
    await sealDueDays({ dataDir, source: SOURCE, now: dayEnd + 60_000, sealDelayMs: 60_000 }),
    [
      'a/2026-10-01',
    ],
  )
  assertEquals((await readGenerations(dayPath(dataDir, '2026-10-01', SOURCE, 'a'))).sealed, 1)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a server writes and seals only its own source of a day', async () => {
  const dataDir = await temporaryDir()
  const text = line('a', '2026-10-01', { type: 'error', visit: 'v', at: 1, page: '/' })
  await applySegment({ dataDir, source: SOURCE, segment: 1, text })
  await applySegment({ dataDir, source: OTHER_SOURCE, segment: 1, text })
  const now = Date.parse('2026-10-03')
  assertEquals(await sealDueDays({ dataDir, source: SOURCE, now, sealDelayMs: 0 }), [
    'a/2026-10-01',
  ])
  assertEquals((await readGenerations(dayPath(dataDir, '2026-10-01', SOURCE, 'a'))).sealed, 1)
  const other = await readGenerations(dayPath(dataDir, '2026-10-01', OTHER_SOURCE, 'a'))
  assertEquals([other.sealed, other.raws], [0, [1]])
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('the storage loop moves the log into columns and removes it', async () => {
  const dataDir = await temporaryDir()
  const storage = createStorage({ dataDir, source: SOURCE, minFree: null })
  const running = storage.run()
  const wal = await openWal({ dir: `${dataDir}/wal`, segmentMs: 20, onSegment: storage.wake })
  await wal.append(line('a', '2026-10-01', { type: 'error', visit: 'v', at: 1, page: '/' }))
  await wal.append(line('a', '2026-10-01', { type: 'error', visit: 'w', at: 2, page: '/' }))
  await waitFor(() => storage.status().processedRows === 2)
  await wal.close()
  storage.stop()
  await running
  assertEquals(await listClosedSegments(`${dataDir}/wal`), [])
  assertEquals(
    (await readDay(dayPath(dataDir, '2026-10-01', SOURCE, 'a'), ['visit'])).columns.visit,
    ['v', 'w'],
  )
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('the worker stores only the valid bytes of a part that a failed write cut', async () => {
  const dataDir = await temporaryDir()
  const valid = line('a', '2026-10-01', { type: 'error', visit: 'v', at: 1, page: '/' })
  const failed = line('a', '2026-10-01', { type: 'error', visit: 'w', at: 2, page: '/' })
  await Deno.mkdir(`${dataDir}/wal`)
  const name = segmentFileName(1, 'log', new TextEncoder().encode(valid).length)
  await Deno.writeTextFile(`${dataDir}/wal/${name}`, valid + failed)
  const storage = createStorage({ dataDir, source: SOURCE, minFree: null })
  const running = storage.run()
  await waitFor(() => storage.status().processedRows === 1)
  storage.stop()
  await running
  assertEquals(await listClosedSegments(`${dataDir}/wal`), [])
  assertEquals(
    (await readDay(dayPath(dataDir, '2026-10-01', SOURCE, 'a'), ['visit'])).columns.visit,
    ['v'],
  )
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a broken day does not stop retention or the other days', async () => {
  const dataDir = await temporaryDir()
  const text = line('a', '2026-09-01', { type: 'error', visit: 'v', at: 1, page: '/' }) +
    line('b', '2026-09-01', { type: 'error', visit: 'v', at: 1, page: '/' })
  await applySegment({ dataDir, source: SOURCE, segment: 1, text })
  await Deno.writeTextFile(
    `${dayPath(dataDir, '2026-09-01', SOURCE, 'a')}/raw-1/commit.json`,
    '{broken',
  )
  const sealed = await sealDueDays({
    dataDir,
    source: SOURCE,
    now: Date.parse('2026-09-03'),
    sealDelayMs: 0,
  })
  assertEquals(sealed, ['b/2026-09-01'])
  let checks = 0
  const storage = createStorage({
    dataDir,
    source: SOURCE,
    minFree: { percent: 10 },
    usage: () => {
      checks++
      return Promise.resolve({ totalBytes: 100, freeBytes: 50 })
    },
  })
  const running = storage.run()
  await waitFor(() => checks > 0)
  storage.stop()
  await running
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a day that fails keeps its records aside, in order, also over a restart', async () => {
  const dataDir = await temporaryDir()
  const day = '2026-10-01'
  const record = (visit) => ({ type: 'error', visit, at: 1, page: '/' })
  await applySegment({ dataDir, source: SOURCE, segment: 1, text: line('a', day, record('v1')) })
  const commit = `${dayPath(dataDir, day, SOURCE, 'a')}/raw-1/commit.json`
  const good = await Deno.readTextFile(commit)
  await Deno.writeTextFile(commit, '{broken')
  const wal = `${dataDir}/wal`
  await Deno.mkdir(wal)
  await Deno.writeTextFile(
    `${wal}/${segmentFileName(2, 'log')}`,
    line('a', day, record('v2')) + line('b', day, record('w')),
  )
  await Deno.writeTextFile(`${wal}/${segmentFileName(3, 'log')}`, line('a', day, record('v3')))
  const first = createStorage({ dataDir, source: SOURCE, minFree: null, maintenanceMs: 20 })
  const running = first.run()
  await waitFor(() => first.status().processedRows === 1 && first.status().pendingSegments === 0)
  assertEquals(first.status().heldDays.map((entry) => entry.day), [`a/${day}`])
  assert(first.status().heldDays[0].error)
  first.stop()
  await running
  assertEquals(await listClosedSegments(wal), [])
  assertEquals((await readDay(dayPath(dataDir, day, SOURCE, 'b'), ['visit'])).columns.visit, ['w'])
  assertEquals(await listHeldDays(dataDir), [`a/${day}`])

  await Deno.writeTextFile(commit, good)
  const second = createStorage({ dataDir, source: SOURCE, minFree: null, maintenanceMs: 20 })
  const again = second.run()
  await waitFor(() => second.status().processedRows === 2)
  second.stop()
  await again
  assertEquals(second.status().heldDays, [])
  assertEquals(await listHeldDays(dataDir), [])
  assertEquals((await readDay(dayPath(dataDir, day, SOURCE, 'a'), ['visit'])).columns.visit, [
    'v1',
    'v2',
    'v3',
  ])
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test({
  name: 'a log part that cannot be read is set aside after three tries',
  ignore: Deno.build.os === 'windows' || Deno.uid() === 0,
  fn: async () => {
    const dataDir = await temporaryDir()
    const wal = `${dataDir}/wal`
    await Deno.mkdir(wal)
    const path = `${wal}/${segmentFileName(1, 'log')}`
    await Deno.writeTextFile(path, line('a', '2026-10-01', { type: 'error', visit: 'v', at: 1 }))
    await Deno.chmod(path, 0o000)
    await Deno.writeTextFile(
      `${wal}/${segmentFileName(2, 'log')}`,
      line('a', '2026-10-01', { type: 'error', visit: 'w', at: 2, page: '/' }),
    )
    const storage = createStorage({ dataDir, source: SOURCE, minFree: null, retryMs: 10 })
    const running = storage.run()
    await waitFor(() => storage.status().processedRows === 1)
    storage.stop()
    await running
    assertEquals(storage.status().unreadableSegments, 1)
    assertEquals(await listClosedSegments(wal), [])
    await Deno.stat(`${path}.unreadable`)
    await Deno.remove(dataDir, { recursive: true })
  },
})
