import { validateRecord } from '../src/records.js'
import { createRandom, DEMO_APPS, seedLines } from '../dev/demo-data.js'
import { assert, assertEquals } from './assert.js'

Deno.test('the demo data is valid records of every day, up to the current time', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  const lines = seedLines({ random: createRandom(42), now, days: 3 })
  const apps = new Map(DEMO_APPS.map(({ name, build, segments }) => [name, {
    pages: new Set(build.pages),
    zones: new Set(build.zones),
    outcomes: new Set(build.outcomes),
    segments,
  }]))
  const days = new Set()
  const names = new Set()
  for (const line of lines) {
    const [name, day, { country, ...record }] = JSON.parse(line)
    const app = apps.get(name)
    assert(app, `${name} is not a demo app`)
    names.add(name)
    assertEquals(day, new Date(record.at).toISOString().slice(0, 10))
    assert(record.at < now, `${record.at} is after the current time`)
    const { problem } = validateRecord(record, app, country, record.at)
    assertEquals(problem, undefined, line)
    days.add(day)
  }
  assertEquals([...days].sort(), ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
  assertEquals([...names].sort(), ['crm', 'docs', 'shop'])
})
