import {
  createToken,
  createTokenVerifier,
  EMPTY_BODY_HASH,
  findOrCreateKey,
  generateKey,
  requestTarget,
  resolveKey,
  safeEqual,
} from '../src/auth.js'
import { assert, assertEquals, assertThrows, temporaryDir } from './assert.js'

Deno.test('a token works once', async () => {
  const key = generateKey()
  assertEquals(key.length, 32)
  const verify = createTokenVerifier(key)
  const request = { method: 'GET', path: '/status' }
  const token = await createToken(key, request)
  const target = { method: 'GET', target: '/status' }
  assertEquals(await verify(token, target), { problem: '', bodyHash: EMPTY_BODY_HASH })
  assertEquals((await verify(token, target)).problem, 'token already used')
})

Deno.test('a token signed with another key or too old fails', async () => {
  const verify = createTokenVerifier('right-key')
  const request = { method: 'POST', path: '/query', bodyHash: 'a'.repeat(64) }
  const target = { method: 'POST', target: '/query' }
  const problem = async (token, against = target) => (await verify(token, against)).problem
  assert((await problem(await createToken('wrong-key', request))).startsWith('wrong key'))
  assertEquals(await problem('garbage'), 'malformed token')
  assertEquals(await problem(''), 'malformed token')
  assert((await problem(await createToken('right-key', request), { ...target, target: '/apps' }))
    .includes('another request'))
  const old = createTokenVerifier('right-key', -1)
  assert((await old(await createToken('right-key', request), target)).problem.startsWith('token'))
  assertEquals(requestTarget('/apps/x/../y?app=a'), '/apps/y?app=a')
})

Deno.test('the key comes from a file or from the value', async () => {
  const dir = await temporaryDir()
  const path = `${dir}/key`
  await Deno.writeTextFile(path, 'from-file\n')
  assertEquals(resolveKey(path), { key: 'from-file', path })
  assertEquals(resolveKey('plain-key-value'), { key: 'plain-key-value', path: '' })
  assertEquals(resolveKey(`${dir}/missing`), { key: '', path: `${dir}/missing` })
  assertThrows(() => resolveKey(dir), /cannot read the key file/)
  assert(safeEqual('a', 'a') && !safeEqual('a', 'b') && !safeEqual('a', 'aa'))
  await Deno.remove(dir, { recursive: true })
})

Deno.test('the server saves a key as text only when the key file is empty', async () => {
  const dir = await temporaryDir()
  const path = `${dir}/key`
  assertEquals(findOrCreateKey('first-key-value', path), { key: 'first-key-value', path })
  assertEquals(await Deno.readTextFile(path), 'first-key-value\n')
  assertEquals(findOrCreateKey('first-key-value', path), { key: 'first-key-value', path })
  assertThrows(() => findOrCreateKey('other-key-value', path), /holds a different key/)
  assertEquals(await Deno.readTextFile(path), 'first-key-value\n')
  if (Deno.uid() !== 0) {
    await Deno.mkdir(`${dir}/locked`, { mode: 0o500 })
    assertThrows(() => findOrCreateKey('new-key-value', `${dir}/locked/key`), /cannot save the key/)
  }
  await Deno.remove(dir, { recursive: true })
})
