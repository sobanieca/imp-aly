import {
  addReadyValue,
  bucketMiddle,
  bucketOf,
  createReady,
  isBucket,
  mergeReady,
  readyPercentile,
  readyShareUnder,
  readyToJson,
} from '../src/ready.js'
import { assertEquals } from './assert.js'

Deno.test('a bucket is the value floored to 2 significant digits', () => {
  assertEquals([0, 7, 99, 100, 423, 999, 1234, 25617, 3_600_000].map(bucketOf), [
    0,
    7,
    99,
    100,
    420,
    990,
    1200,
    25000,
    3_600_000,
  ])
  assertEquals([0, 87, 420, 2500, 3_600_000].every(isBucket), true)
  assertEquals([425, 2550, -1, 1.5, 3_700_000].some(isBucket), false)
  assertEquals([87, 420, 1200, 25000].map(bucketMiddle), [87, 425, 1250, 25500])
})

Deno.test('percentiles and shares come from the merged buckets', () => {
  const ready = (values) => {
    const result = createReady()
    for (const value of values) addReadyValue(result, value)
    return result
  }
  const a = ready([300, 300, 300, 300, 300, 300, 420, 421, 429, 1234])
  const b = ready([305, 309, 420, 425, 1200, 1250, 1290, 1299, 2500, 2599])
  assertEquals(readyPercentile(a, 75), 425)
  assertEquals(readyPercentile(b, 75), 1250)
  const merged = createReady()
  mergeReady(merged, readyToJson(a, true))
  mergeReady(merged, JSON.parse(JSON.stringify(readyToJson(b, true))))
  assertEquals(merged.count, 20)
  assertEquals(merged.min, 300)
  assertEquals(merged.max, 2599)
  assertEquals(readyPercentile(merged, 50), 425)
  assertEquals(readyPercentile(merged, 75), 1250)
  assertEquals(readyPercentile(merged, 95), 2550)
  assertEquals(readyPercentile(merged, 1), 305)
  assertEquals(readyShareUnder(merged, 1200), 65)
  assertEquals(readyShareUnder(merged, 2500), 90)
  assertEquals(readyToJson(a, false), { count: 10, sum: 4304, min: 300, max: 1234 })
})
