import { addDays, addMonths, dayCount, dayOf, isDay, weekOf } from '../src/days.js'
import { assert, assertEquals } from './assert.js'

Deno.test('days count in UTC', () => {
  assertEquals(dayOf(Date.parse('2026-10-03T23:59:59Z')), '2026-10-03')
  assertEquals(addDays('2026-02-28', 1), '2026-03-01')
  assertEquals(addDays('2026-03-01', -1), '2026-02-28')
  assertEquals(dayCount('2026-09-29', '2026-10-02'), 4)
  assertEquals(dayCount('2026-10-02', '2026-10-02'), 1)
  assertEquals(dayCount('2026-03-28', '2026-03-30'), 3)
})

Deno.test('a month back keeps the day or takes the last day of the month', () => {
  assertEquals(addMonths('2026-03-31', -1), '2026-02-28')
  assertEquals(addMonths('2024-03-31', -1), '2024-02-29')
  assertEquals(addMonths('2026-10-03', -60), '2021-10-03')
})

Deno.test('a week starts on Monday', () => {
  assertEquals(weekOf('2026-10-04'), '2026-09-28')
  assertEquals(weekOf('2026-09-28'), '2026-09-28')
  assert(isDay('2026-02-28'))
  assert(!isDay('2026-02-30'))
})
