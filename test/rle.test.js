import { decodeRuns, splitLines } from '../src/rle.js'
import { assertEquals, assertThrows } from './assert.js'

Deno.test('runs decode with nulls', () => {
  assertEquals(decodeRuns('2\tpl\n1\t\n3\ten\n1\t\n', 7), [
    'pl',
    'pl',
    null,
    'en',
    'en',
    'en',
    null,
  ])
})

Deno.test('decoding checks the row count', () => {
  assertThrows(() => decodeRuns('2\tpl\n', 3), /expected 3/)
  assertThrows(() => decodeRuns('5\tpl\n', 3), /wrong count/)
  assertThrows(() => decodeRuns('2\tpl', 2), /line break/)
})

Deno.test('plain column lines decode empty lines as null', () => {
  assertEquals(splitLines(''), [])
  assertEquals(splitLines('a\n\nb\n'), ['a', null, 'b'])
})
