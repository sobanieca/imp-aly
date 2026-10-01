import { readDay, readGenerations } from '../src/column-store.js'
import { applySegment, createStorage, parseSegment, sealDueDays } from '../src/storage.js'
import { listClosedSegments, openWal } from '../src/wal.js'
import { assertEquals, temporaryDir, waitFor } from './assert.js'

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
  assertEquals(await applySegment({ dataDir, segment: 1, text }), 1)
  assertEquals(await applySegment({ dataDir, segment: 1, text }), 0)
  assertEquals((await readDay(`${dataDir}/apps/a/2026-10-01`, ['visit'])).rows, 1)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('days are sealed only after the delay', async () => {
  const dataDir = await temporaryDir()
  const text = line('a', '2026-10-01', { type: 'error', visit: 'v', at: 1, page: '/' })
  await applySegment({ dataDir, segment: 1, text })
  const dayEnd = Date.parse('2026-10-02')
  assertEquals(await sealDueDays({ dataDir, now: dayEnd + 10, sealDelayMs: 60_000 }), [])
  assertEquals(await sealDueDays({ dataDir, now: dayEnd + 60_000, sealDelayMs: 60_000 }), [
    'a/2026-10-01',
  ])
  assertEquals((await readGenerations(`${dataDir}/apps/a/2026-10-01`)).sealed, 1)
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('the storage loop moves the log into columns and removes it', async () => {
  const dataDir = await temporaryDir()
  const storage = createStorage({ dataDir, minFree: null })
  const running = storage.run()
  const wal = await openWal({ dir: `${dataDir}/wal`, segmentMs: 20, onSegment: storage.wake })
  await wal.append(line('a', '2026-10-01', { type: 'error', visit: 'v', at: 1, page: '/' }))
  await wal.append(line('a', '2026-10-01', { type: 'error', visit: 'w', at: 2, page: '/' }))
  await waitFor(() => storage.status().processedRows === 2)
  await wal.close()
  storage.stop()
  await running
  assertEquals(await listClosedSegments(`${dataDir}/wal`), [])
  assertEquals((await readDay(`${dataDir}/apps/a/2026-10-01`, ['visit'])).columns.visit, ['v', 'w'])
  await Deno.remove(dataDir, { recursive: true })
})

Deno.test('a broken day does not stop retention or the other days', async () => {
  const dataDir = await temporaryDir()
  const text = line('a', '2026-09-01', { type: 'error', visit: 'v', at: 1, page: '/' }) +
    line('b', '2026-09-01', { type: 'error', visit: 'v', at: 1, page: '/' })
  await applySegment({ dataDir, segment: 1, text })
  await Deno.writeTextFile(`${dataDir}/apps/a/2026-09-01/raw-1/commit.json`, '{broken')
  const sealed = await sealDueDays({ dataDir, now: Date.parse('2026-09-03'), sealDelayMs: 0 })
  assertEquals(sealed, ['b/2026-09-01'])
  let checks = 0
  const storage = createStorage({
    dataDir,
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
