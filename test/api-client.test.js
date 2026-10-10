import { parseTimeout } from '../src/args.js'
import { callServer, queryServers, resolveOne, resolveTargets } from '../src/api-client.js'
import { defaultFileName } from '../src/commands/backup.js'
import { readServeOptions, serviceArgs } from '../src/commands/server.js'
import { addServer } from '../src/servers.js'
import { serviceTarget, unitFile } from '../src/service.js'
import { assert, assertEquals, assertRejects, assertThrows, temporaryDir } from './assert.js'

const KEY = 'api-client-test-key-0123456789'

const answer = {
  days: ['2026-10-01'],
  summaryDays: 1,
  scanned: 4,
  matched: 4,
  skippedDays: [],
  groups: [{ by: [], records: 4, visits: 2 }],
  appConfig: 'a',
}

const startFakeServers = () => {
  const stalled = []
  const handlers = {
    good: () => Response.json(answer),
    html: () => new Response('<html>proxy</html>', { headers: { 'content-type': 'text/html' } }),
    wrong: () => Response.json({ hello: 'world' }),
    stalled: () => new Promise((resolve) => stalled.push(resolve)),
  }
  const servers = Object.entries(handlers).map(([name, handler]) => ({
    name,
    server: Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, handler),
  }))
  return {
    targets: servers.map(({ name, server }) => ({
      label: name,
      server: name,
      url: `http://127.0.0.1:${server.addr.port}`,
      auth: KEY,
    })),
    stop: async () => {
      for (const resolve of stalled) resolve(new Response('late'))
      await Promise.all(servers.map(({ server }) => server.shutdown()))
    },
  }
}

Deno.test('a stalled server and a reply that is not an answer fail, and the others still count', async () => {
  const { targets, stop } = startFakeServers()
  try {
    const started = Date.now()
    const { result } = await queryServers(targets, { app: 'myapp', from: '2026-10-01' }, {
      timeoutMs: 300,
    })
    assert(Date.now() - started < 5_000, 'the query waited for the stalled server')
    assertEquals(result.rows, [{ records: 4 }])
    const reasons = Object.fromEntries(
      result.failedServers.map(({ server, reason }) => [server, reason]),
    )
    assertEquals(Object.keys(reasons).sort(), ['html', 'stalled', 'wrong'])
    assert(/not JSON/.test(reasons.html), reasons.html)
    assert(/not a query answer/.test(reasons.wrong), reasons.wrong)
    assert(/did not answer in 0.3 s/.test(reasons.stalled), reasons.stalled)
    const [, html] = targets
    await assertRejects(
      () => callServer(html, { method: 'GET', path: '/apps' }),
      /answered 200 with a reply that is not JSON/,
    )
  } finally {
    await stop()
  }
})

Deno.test('--timeout takes whole seconds', () => {
  assertEquals(parseTimeout(undefined), undefined)
  assertEquals(parseTimeout('5'), 5_000)
  assertThrows(() => parseTimeout('0'), /above 0/)
  assertThrows(() => parseTimeout('1.5'), /above 0/)
})

const unitOf = (flags, keyPath = '/root/.secret/imp-aly-key') => {
  const options = { ...readServeOptions(flags), dataDir: '/var/lib/imp-aly' }
  return unitFile({
    args: serviceArgs(options),
    dataDir: options.dataDir,
    ports: [options.port, options.adminPort],
    keyPath,
    tlsCert: options.tlsCert,
    tlsKey: options.tlsKey,
  })
}

Deno.test('the local service gives the admin address and the key file from its unit file', () => {
  assertEquals(serviceTarget(unitOf({})), {
    url: 'http://127.0.0.1:2981',
    keyPath: '/root/.secret/imp-aly-key',
  })
  assertEquals(serviceTarget(unitOf({ adminPort: '9000', bind: '0.0.0.0' }, '/srv/k e y')), {
    url: 'http://127.0.0.1:9000',
    keyPath: '/srv/k e y',
  })
  assertEquals(serviceTarget(unitOf({ adminBind: '10.0.0.5' })).url, 'http://10.0.0.5:2981')
  assertEquals(serviceTarget(unitOf({ bind: '::' })).url, 'http://[::1]:2981')
  assertEquals(serviceTarget(unitOf({ adminBind: 'fd00::5' })).url, 'http://[fd00::5]:2981')
  assertEquals(
    serviceTarget(unitOf({ tlsCert: '/etc/cert.pem', tlsKey: '/etc/key.pem' })).url,
    'https://127.0.0.1:2981',
  )
  assertEquals(serviceTarget(null), null)
})

Deno.test('with no saved server, the client calls the local service with its key file', async () => {
  const path = `${await temporaryDir()}/servers.json`
  const local = () => ({ url: 'http://127.0.0.1:9000', keyPath: '/root/.secret/imp-aly-key' })
  assertEquals(resolveOne({}, path, local), {
    label: 'http://127.0.0.1:9000',
    url: 'http://127.0.0.1:9000',
    auth: '/root/.secret/imp-aly-key',
    server: null,
    service: true,
  })
  assertEquals(resolveOne({ auth: 'other' }, path, local).auth, 'other')
  assertEquals(resolveOne({}, path, () => null).url, 'http://127.0.0.1:2981')
  assertEquals(resolveOne({ url: 'http://x.example' }, path, local).service, false)
  addServer({ name: 'eu', url: 'https://eu.example' }, path)
  assertEquals(resolveTargets({}, path, local).map((target) => target.server), ['eu'])
})

Deno.test('a backup without a file name gets the period, the granularity and the day', () => {
  assertEquals(
    defaultFileName('30d', 'week', new Date('2026-10-09T08:00:00Z')),
    'imp-aly-backup-30d-by-week-2026-10-09.tar.gz',
  )
})
