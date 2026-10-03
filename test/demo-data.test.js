import { validateRecord } from '../src/records.js'
import { createRandom, DEMO_APP, DEMO_MAP, DEMO_SEGMENTS, seedLines } from '../dev/demo-data.js'
import { assert, assertEquals } from './assert.js'

Deno.test('the demo data is valid records of every day, up to the current time', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  const lines = seedLines({ random: createRandom(42), now, days: 3 })
  const app = { pages: new Set(DEMO_MAP), segments: DEMO_SEGMENTS }
  const days = new Set()
  for (const line of lines) {
    const [name, day, { country, ...record }] = JSON.parse(line)
    assertEquals(name, DEMO_APP)
    assertEquals(day, new Date(record.at).toISOString().slice(0, 10))
    assert(record.at < now, `${record.at} is after the current time`)
    const { problem } = validateRecord(record, app, country, record.at)
    assertEquals(problem, undefined, line)
    days.add(day)
  }
  assertEquals([...days].sort(), ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
})
