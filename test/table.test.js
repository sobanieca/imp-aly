import { formatTable } from '../src/table.js'
import { assertEquals } from './assert.js'

Deno.test('a table pads the columns and aligns the numbers right', () => {
  const text = formatTable(['page', 'records'], [{ page: '/', records: 12 }, { page: '/a/b' }])
  assertEquals(text, 'page   records\n/           12\n/a/b         -')
})

Deno.test('a table of many rows does not overflow the stack', () => {
  const rows = Array.from({ length: 300_000 }, (_, index) => ({ id: index }))
  const lines = formatTable(['id'], rows).split('\n')
  assertEquals(lines.length, 300_001)
  assertEquals(lines.at(-1), '299999')
})
