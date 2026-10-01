import { decodeRuns, encodeRuns, splitLines } from '../src/rle.js'
import { assertEquals, assertThrows } from './assert.js'

Deno.test('run-length encoding round trips with nulls', () => {
  const values = ['pl', 'pl', null, 'en', 'en', 'en', null]
  const order = values.map((_, index) => index)
  const text = encodeRuns(values, order)
  assertEquals(text, '2\tpl\n1\t\n3\ten\n1\t\n')
  assertEquals(decodeRuns(text, 7), values)
})

Deno.test('encoding follows the given order', () => {
  assertEquals(encodeRuns(['b', 'a', 'b'], [1, 0, 2]), '1\ta\n2\tb\n')
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
