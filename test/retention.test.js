import { applySegment } from '../src/storage.js'
import { enforceRetention, minFreeBytes, parseDf, parseMinFree } from '../src/retention.js'
import { assertEquals, assertThrows, temporaryDir } from './assert.js'

Deno.test('min free takes a percent or a size', () => {
  assertEquals(parseMinFree('10%'), { percent: 10 })
  assertEquals(parseMinFree('5GB'), { bytes: 5 * 1024 ** 3 })
  assertEquals(parseMinFree('512mb'), { bytes: 512 * 1024 ** 2 })
  assertThrows(() => parseMinFree('0%'), /not a size/)
  assertThrows(() => parseMinFree('100%'), /not a size/)
  assertThrows(() => parseMinFree('lots'), /not a size/)
  assertEquals(minFreeBytes({ percent: 10 }, 1000), 100)
  assertEquals(minFreeBytes({ bytes: 7 }, 1000), 7)
})

Deno.test('df output is parsed', () => {
  const text = 'Filesystem     1024-blocks      Used Available Capacity Mounted on\n' +
    '/dev/sda1         40000000  30000000  10000000      75% /\n'
  assertEquals(parseDf(text), { totalBytes: 40000000 * 1024, freeBytes: 10000000 * 1024 })
  assertThrows(() => parseDf('nonsense'), /unexpected/)
})

Deno.test('the oldest days go first until the disk has room, and today stays', async () => {
  const dataDir = await temporaryDir()
  const record = { type: 'error', visit: 'v', at: 1, page: '/' }
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']
  let segment = 0
  for (const day of days) {
    for (const app of ['a', 'b']) {
      await applySegment({
        dataDir,
        segment: ++segment,
        text: `${JSON.stringify([app, day, record])}\n`,
      })
    }
  }
  let free = 0
  const usage = async (path) => {
    const remaining = []
    for await (const app of Deno.readDir(`${path}/apps`)) {
      for await (const day of Deno.readDir(`${path}/apps/${app.name}`)) remaining.push(day.name)
    }
    free = 100 - remaining.length * 10
    return { totalBytes: 100, freeBytes: free }
  }
  const now = Date.parse('2026-10-01T12:00:00Z')
  const result = await enforceRetention({ dataDir, minFree: { percent: 55 }, usage, now })
  assertEquals(result.removed, ['a/2026-09-28', 'b/2026-09-28', 'a/2026-09-29', 'b/2026-09-29'])
  assertEquals(free, 60)
  const all = await enforceRetention({ dataDir, minFree: { percent: 99 }, usage, now })
  assertEquals(all.removed, ['a/2026-09-30', 'b/2026-09-30'])
  assertEquals(free, 80)
  await Deno.remove(dataDir, { recursive: true })
})
