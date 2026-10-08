import { readTar, tarEnd, tarEntry, tarHeader } from '../src/tar.js'
import { assertEquals, assertRejects, assertThrows } from './assert.js'

const encoder = new TextEncoder()

const decoder = new TextDecoder()

const streamOf = (chunks, size = 100) => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const pieces = []
  for (let start = 0; start < bytes.length; start += size) {
    pieces.push(bytes.subarray(start, start + size))
  }
  return ReadableStream.from(pieces)
}

const read = async (stream, maxEntryBytes = 1_000_000) => {
  const files = []
  for await (const { name, data } of readTar(stream, { maxEntryBytes })) {
    files.push([name, decoder.decode(data)])
  }
  return files
}

Deno.test('an archive round trips in chunks of any size', async () => {
  const chunks = [
    ...tarEntry({ name: 'a/one.txt', data: encoder.encode('one\n'), mtimeMs: 0 }),
    ...tarEntry({ name: 'a/empty.txt', data: new Uint8Array(), mtimeMs: 0 }),
    ...tarEntry({ name: 'a/long.txt', data: encoder.encode('x'.repeat(1300)), mtimeMs: 0 }),
    tarEnd(),
  ]
  for (const size of [1, 7, 512, 4096]) {
    assertEquals(await read(streamOf(chunks, size)), [
      ['a/one.txt', 'one\n'],
      ['a/empty.txt', ''],
      ['a/long.txt', 'x'.repeat(1300)],
    ])
  }
})

Deno.test('folders are skipped and a leading ./ is removed', async () => {
  const folder = tarHeader({ name: './a/', size: 0, mtimeMs: 0 })
  folder[156] = '5'.charCodeAt(0)
  folder.fill(32, 148, 156)
  const sum = folder.reduce((total, byte) => total + byte, 0)
  folder.set(encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148)
  const chunks = [folder, ...tarEntry({ name: './a/b.txt', data: encoder.encode('b'), mtimeMs: 0 })]
  assertEquals(await read(streamOf(chunks)), [['a/b.txt', 'b']])
})

Deno.test('a damaged, cut or too large archive fails', async () => {
  const entry = [...tarEntry({ name: 'a.txt', data: encoder.encode('abc'), mtimeMs: 0 })]
  const damaged = entry.map((chunk) => chunk.slice())
  damaged[0][0] = 'b'.charCodeAt(0)
  await assertRejects(() => read(streamOf(damaged)), /checksum/)
  await assertRejects(() => read(streamOf([entry[0]])), /ends in the middle/)
  await assertRejects(() => read(streamOf(entry), 2), /larger than 2 bytes/)
})

Deno.test('a long name goes into the prefix field and reads back whole', async () => {
  const app = 'a'.repeat(63)
  const name = `${app}/0123456789abcdef/months/2026-09/summary-counts.tsv`
  const header = tarHeader({ name, size: 1, mtimeMs: 0 })
  assertEquals(decoder.decode(header.subarray(0, 18)), 'summary-counts.tsv')
  const prefix = name.slice(0, name.lastIndexOf('/'))
  assertEquals(decoder.decode(header.subarray(345, 345 + prefix.length + 1)), `${prefix}\0`)
  const chunks = [...tarEntry({ name, data: encoder.encode('x'), mtimeMs: 0 }), tarEnd()]
  assertEquals(await read(streamOf(chunks)), [[name, 'x']])
  assertThrows(() => tarHeader({ name: `${'b'.repeat(160)}/c`, size: 0, mtimeMs: 0 }), /too long/)
  assertThrows(() => tarHeader({ name: `a/${'c'.repeat(101)}`, size: 0, mtimeMs: 0 }), /too long/)
})
