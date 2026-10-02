import { createSha256, hashStream, sha256Hex } from '../src/sha256.js'
import { assertEquals } from './assert.js'

const subtleHex = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')

Deno.test('the hash matches the platform for any length and any split', async () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 65_000]) {
    const bytes = crypto.getRandomValues(new Uint8Array(length))
    const expected = await subtleHex(bytes)
    assertEquals(sha256Hex(bytes), expected, `length ${length}`)
    const hash = createSha256()
    for (let offset = 0; offset < length;) {
      const size = 1 + Math.floor(Math.random() * 200)
      hash.update(bytes.subarray(offset, offset + size))
      offset += size
    }
    assertEquals(hash.digest(), expected, `split length ${length}`)
  }
  assertEquals(
    sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

Deno.test('a stream hashes like its bytes', async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(10_000))
  const stream = ReadableStream.from([
    bytes.subarray(0, 3),
    bytes.subarray(3, 9_000),
    bytes.subarray(9_000),
  ])
  assertEquals(await hashStream(stream), await subtleHex(bytes))
})
