import {
  addGroup,
  addServer,
  loadServers,
  parseServerUrl,
  removeSaved,
  resolveTarget,
  resolveTargets,
  serverNames,
  useSaved,
} from '../src/servers.js'
import { assertEquals, assertThrows, temporaryDir } from './assert.js'

const storePath = async () => `${await temporaryDir()}/imp-aly/servers.json`

Deno.test('a saved server keeps its URL and its key, and becomes the default', async () => {
  const path = await storePath()
  assertEquals(loadServers(path), { default: '', servers: [], groups: [] })
  addServer({ name: 'eu', url: 'https://eu.example/', auth: '/keys/eu' }, path)
  addServer({ name: 'us', url: 'http://203.0.113.10:2981', auth: 'rawkey123' }, path)
  assertEquals(loadServers(path), {
    default: 'us',
    servers: [
      { name: 'eu', url: 'https://eu.example', auth: '/keys/eu' },
      { name: 'us', url: 'http://203.0.113.10:2981', auth: 'rawkey123' },
    ],
    groups: [],
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
  useSaved('a', path)
  assertEquals(loadServers(path).default, 'a')
  assertEquals(removeSaved('b', path).server.url, 'http://b.example')
  assertEquals(loadServers(path).default, 'a')
  removeSaved('a', path)
  assertEquals(loadServers(path).default, 'c')
  removeSaved('c', path)
  assertEquals(loadServers(path), { default: '', servers: [], groups: [] })
  assertThrows(() => removeSaved('c', path), /no server or group named "c"/)
  assertThrows(() => useSaved('x', path), /no server or group named "x"/)
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
  assertEquals(resolveTarget({}, path, () => null), {
    url: undefined,
    auth: undefined,
    server: null,
  })
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
  assertThrows(() => resolveTarget({ server: 'nope' }, path), /no server or group named "nope"/)
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

Deno.test('a group names a list of saved servers, and -s takes its name', async () => {
  const path = await storePath()
  addServer({ name: 'eu-1', url: 'https://eu-1.example', auth: '/keys/eu' }, path)
  addServer({ name: 'eu-2', url: 'https://eu-2.example' }, path)
  addServer({ name: 'us', url: 'https://us.example' }, path)
  assertEquals(addGroup({ name: 'prod', servers: 'eu-1, eu-2' }, path), {
    name: 'prod',
    servers: ['eu-1', 'eu-2'],
  })
  assertEquals(loadServers(path).default, 'us')
  assertEquals(resolveTargets({ server: 'prod' }, path), [
    { url: 'https://eu-1.example', auth: '/keys/eu', server: 'eu-1' },
    { url: 'https://eu-2.example', auth: undefined, server: 'eu-2' },
  ])
  assertEquals(resolveTargets({ server: 'prod,us', auth: 'k' }, path).map((t) => t.auth), [
    'k',
    'k',
    'k',
  ])
  assertThrows(() => resolveTargets({ server: 'prod,eu-2' }, path), /names the server "eu-2" twice/)
  assertThrows(() => resolveTarget({ server: 'prod' }, path), /one server, not "prod"/)
  addGroup({ name: 'prod', servers: 'eu-2' }, path)
  assertEquals(resolveTarget({ server: 'prod' }, path).server, 'eu-2')
  assertEquals(loadServers(path).groups, [{ name: 'prod', servers: ['eu-2'] }])
})

Deno.test('a group can be the default', async () => {
  const path = await storePath()
  addServer({ name: 'a', url: 'https://a.example' }, path)
  addServer({ name: 'b', url: 'https://b.example' }, path)
  addGroup({ name: 'all', servers: 'a,b' }, path)
  assertEquals(useSaved('all', path).group.name, 'all')
  assertEquals(resolveTargets({}, path).map((target) => target.server), ['a', 'b'])
  assertThrows(() => resolveTarget({}, path), /default "all" is a group/)
  assertEquals(resolveTarget({ server: 'a' }, path).server, 'a')
  assertEquals(resolveTarget({ url: 'http://x.example' }, path).url, 'http://x.example')
  assertEquals(removeSaved('all', path).group.servers, ['a', 'b'])
  assertEquals(loadServers(path).default, 'b')
  assertEquals(loadServers(path).groups, [])
})

Deno.test('groups and servers share the names, and a group holds only saved servers', async () => {
  const path = await storePath()
  addServer({ name: 'a', url: 'https://a.example' }, path)
  addServer({ name: 'b', url: 'https://b.example' }, path)
  addGroup({ name: 'g', servers: 'a' }, path)
  assertThrows(() => addGroup({ name: 'a', servers: 'b' }, path), /is a saved server/)
  assertThrows(() => addServer({ name: 'g', url: 'https://g.example' }, path), /is a group/)
  assertThrows(() => addGroup({ name: 'h', servers: 'a,x' }, path), /no server named "x"/)
  assertThrows(() => addGroup({ name: 'h', servers: 'g' }, path), /not groups/)
  assertThrows(() => addGroup({ name: 'h', servers: 'a,a' }, path), /twice/)
  assertThrows(() => addGroup({ name: 'h', servers: '' }, path), /list of server names/)
  assertThrows(() => addGroup({ name: 'bad name', servers: 'a' }, path), /not a group name/)
  assertThrows(() => removeSaved('a', path), /in the group "g"/)
  removeSaved('b', path)
  assertEquals(loadServers(path).servers.map((entry) => entry.name), ['a'])
})
