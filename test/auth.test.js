import {
  findOrCreateKey,
  generateKey,
  handOverKey,
  KEY_LOADED_FILE,
  NEW_KEY_FILE,
  resolveKey,
  takeNewKey,
  writeKeyFile,
} from '../src/auth.js'
import {
  createToken,
  createTokenVerifier,
  EMPTY_BODY_HASH,
  importSigningKey,
  requestTarget,
  safeEqual,
} from '../src/token.js'
import { assert, assertEquals, assertThrows, temporaryDir } from './assert.js'

Deno.test('a token signed with a non-extractable key passes the check of the text key', async () => {
  const key = generateKey()
  const verify = createTokenVerifier(key)
  const token = await createToken(await importSigningKey(key), { method: 'POST', path: '/query' })
  assertEquals((await verify(token, { method: 'POST', target: '/query' })).problem, '')
})

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

Deno.test('a new key replaces the key file with owner access', async () => {
  const dir = await temporaryDir()
  const path = `${dir}/key`
  await Deno.writeTextFile(`${path}.tmp`, 'left over', { mode: 0o644 })
  writeKeyFile(path, 'first-key-value')
  writeKeyFile(path, 'second-key-value')
  assertEquals(await Deno.readTextFile(path), 'second-key-value\n')
  assertEquals((await Deno.stat(path)).mode & 0o777, 0o600)
  assertThrows(() => Deno.statSync(`${path}.tmp`))
  await Deno.remove(dir, { recursive: true })
})

Deno.test('the handed over key is in a folder of its owner, readable by the group only', async () => {
  const root = await temporaryDir()
  const owner = { uid: Deno.uid(), gid: Deno.gid() }
  const dir = `${root}/run`
  const path = handOverKey({ dir, key: 'handed-over-key', ...owner })
  assertEquals(path, `${dir}/${NEW_KEY_FILE}`)
  assertEquals(await Deno.readTextFile(path), 'handed-over-key\n')
  const file = await Deno.lstat(path)
  assertEquals([file.mode & 0o777, file.uid, file.gid], [0o640, owner.uid, owner.gid])
  const folder = await Deno.lstat(dir)
  assertEquals([folder.mode & 0o777, folder.uid, folder.gid], [0o750, owner.uid, owner.gid])
  handOverKey({ dir, key: 'second-key', ...owner })
  assertEquals(await Deno.readTextFile(path), 'second-key\n')
  assertThrows(() => Deno.statSync(`${path}.tmp`))

  assertThrows(
    () => handOverKey({ dir, key: 'k', uid: owner.uid + 1, gid: owner.gid }),
    /must be a folder of the user/,
  )
  await Deno.mkdir(`${root}/elsewhere`)
  await Deno.symlink(`${root}/elsewhere`, `${root}/link`)
  assertThrows(
    () => handOverKey({ dir: `${root}/link`, key: 'k', ...owner }),
    /must be a folder of the user/,
  )
  assertThrows(() => Deno.statSync(`${root}/elsewhere/${NEW_KEY_FILE}`))
  await Deno.remove(root, { recursive: true })
})

Deno.test('the service takes the handed over key, leaves the file, and writes the loaded mark', async () => {
  const handoverDir = await temporaryDir()
  const dataDir = await temporaryDir()
  const place = { handoverDir, dataDir }
  const taken = []
  assertEquals(takeNewKey(place, (key) => taken.push(key)), '')
  assertThrows(() => Deno.statSync(`${dataDir}/${KEY_LOADED_FILE}`))
  await Deno.writeTextFile(`${handoverDir}/${NEW_KEY_FILE}`, 'handed-over-key\n')
  assertThrows(() =>
    takeNewKey(place, () => {
      throw new Error('refused')
    }), /refused/)
  assertThrows(() => Deno.statSync(`${dataDir}/${KEY_LOADED_FILE}`))
  assertEquals(takeNewKey(place, (key) => taken.push(key)), 'handed-over-key')
  assertEquals(taken, ['handed-over-key'])
  assert(Deno.statSync(`${dataDir}/${KEY_LOADED_FILE}`).isFile)
  assertEquals(await Deno.readTextFile(`${handoverDir}/${NEW_KEY_FILE}`), 'handed-over-key\n')
  await Deno.remove(handoverDir, { recursive: true })
  await Deno.remove(dataDir, { recursive: true })
})
