import {
  createToken,
  createTokenVerifier,
  generateKey,
  resolveKey,
  safeEqual,
} from '../src/auth.js'
import { assert, assertEquals, temporaryDir } from './assert.js'

Deno.test('a token works once', async () => {
  const key = generateKey()
  assertEquals(key.length, 32)
  const verify = createTokenVerifier(key)
  const token = await createToken(key)
  assertEquals(await verify(token), '')
  assertEquals(await verify(token), 'token already used')
})

Deno.test('a token signed with another key or too old fails', async () => {
  const verify = createTokenVerifier('right-key')
  assertEquals(await verify(await createToken('wrong-key')), 'wrong key')
  assertEquals(await verify('garbage'), 'malformed token')
  assertEquals(await verify(''), 'malformed token')
  const old = createTokenVerifier('right-key', -1)
  assert((await old(await createToken('right-key'))).startsWith('token expired'))
})

Deno.test('the key comes from a file or from the value', async () => {
  const dir = await temporaryDir()
  const path = `${dir}/key`
  await Deno.writeTextFile(path, 'from-file\n')
  assertEquals(resolveKey(path), { key: 'from-file', path })
  assertEquals(resolveKey('plain-key-value'), { key: 'plain-key-value', path: '' })
  assert(safeEqual('a', 'a') && !safeEqual('a', 'b') && !safeEqual('a', 'aa'))
  await Deno.remove(dir, { recursive: true })
})
