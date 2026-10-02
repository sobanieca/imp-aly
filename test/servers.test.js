import {
  addServer,
  defaultServer,
  loadServers,
  parseServerUrl,
  removeServer,
  resolveTarget,
  serverNames,
  useServer,
} from '../src/servers.js'
import { assertEquals, assertThrows, temporaryDir } from './assert.js'

const storePath = async () => `${await temporaryDir()}/imp-aly/servers.json`

Deno.test('a saved server keeps its URL and its key, and becomes the default', async () => {
  const path = await storePath()
  assertEquals(loadServers(path), { default: '', servers: [] })
  assertEquals(defaultServer(path), null)
  addServer({ name: 'eu', url: 'https://eu.example/', auth: '/keys/eu' }, path)
  addServer({ name: 'us', url: 'http://203.0.113.10:2981', auth: 'rawkey123' }, path)
  assertEquals(loadServers(path), {
    default: 'us',
    servers: [
      { name: 'eu', url: 'https://eu.example', auth: '/keys/eu' },
      { name: 'us', url: 'http://203.0.113.10:2981', auth: 'rawkey123' },
    ],
  })
  assertEquals((await Deno.stat(path)).mode & 0o777, 0o600)
  addServer({ name: 'eu', url: 'https://eu2.example' }, path)
  assertEquals(loadServers(path).servers[0], { name: 'eu', url: 'https://eu2.example' })
  assertEquals(loadServers(path).default, 'eu')
})

Deno.test('use changes the default and rm picks another default', async () => {
  const path = await storePath()
  addServer({ name: 'a', url: 'http://a.example' }, path)
  addServer({ name: 'b', url: 'http://b.example' }, path)
  addServer({ name: 'c', url: 'http://c.example' }, path)
  useServer('a', path)
  assertEquals(defaultServer(path).name, 'a')
  assertEquals(removeServer('b', path).url, 'http://b.example')
  assertEquals(defaultServer(path).name, 'a')
  removeServer('a', path)
  assertEquals(defaultServer(path).name, 'c')
  removeServer('c', path)
  assertEquals(loadServers(path), { default: '', servers: [] })
  assertThrows(() => removeServer('c', path), /no server named "c"/)
  assertThrows(() => useServer('x', path), /no server named "x"/)
})

Deno.test('server names and URLs are checked', async () => {
  const path = await storePath()
  assertThrows(() => addServer({ name: 'bad name', url: 'http://a.example' }, path), /not a server/)
  assertThrows(() => addServer({ name: '-a', url: 'http://a.example' }, path), /not a server/)
  assertThrows(() => addServer({ name: 'a', url: 'a.example:2981' }, path), /not a server URL/)
  assertThrows(() => addServer({ name: 'a', url: 'ftp://a.example' }, path), /not a server URL/)
  assertThrows(() => addServer({ name: 'a', url: 'http://a.example/?x=1' }, path), /query/)
  assertEquals(parseServerUrl('https://a.example/analytics/'), 'https://a.example/analytics')
  assertEquals(loadServers(path).servers, [])
})

Deno.test('the target comes from --url, --server or the default server', async () => {
  const path = await storePath()
  assertEquals(resolveTarget({}, path), { url: undefined, auth: undefined, server: null })
  addServer({ name: 'eu', url: 'https://eu.example', auth: '/keys/eu' }, path)
  addServer({ name: 'us', url: 'https://us.example' }, path)
  assertEquals(resolveTarget({}, path), {
    url: 'https://us.example',
    auth: undefined,
    server: 'us',
  })
  assertEquals(resolveTarget({ server: 'eu' }, path), {
    url: 'https://eu.example',
    auth: '/keys/eu',
    server: 'eu',
  })
  assertEquals(resolveTarget({ server: 'eu', auth: 'other' }, path).auth, 'other')
  assertEquals(resolveTarget({ url: 'http://x.example:2981/', auth: 'k' }, path), {
    url: 'http://x.example:2981',
    auth: 'k',
    server: null,
  })
  assertThrows(() => resolveTarget({ server: 'nope' }, path), /no server named "nope"/)
  assertThrows(() => resolveTarget({ server: 'eu', url: 'http://x.example' }, path), /not both/)
})

Deno.test('a broken servers file is an error', async () => {
  const path = await storePath()
  await Deno.mkdir(path.replace(/\/[^/]+$/, ''), { recursive: true })
  await Deno.writeTextFile(path, '{nope')
  assertThrows(() => loadServers(path), /not valid JSON/)
})

Deno.test('a list of servers is split, and a single-server command refuses it', async () => {
  const path = await storePath()
  addServer({ name: 'a', url: 'https://a.example' }, path)
  assertEquals(serverNames('a, b,c'), ['a', 'b', 'c'])
  assertThrows(() => serverNames('a,,b'), /list of server names/)
  assertThrows(() => serverNames('a,a'), /twice/)
  assertThrows(() => resolveTarget({ server: 'a,b' }, path), /one server/)
})
