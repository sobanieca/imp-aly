import { consoleHosts, createConsoleApp } from '../src/console-api.js'
import { startConsole } from '../src/console.js'
import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
import { addServer } from '../src/servers.js'
import { serveUi } from '../src/static-files.js'
import { assert, assertEquals, assertRejects, temporaryDir, waitFor } from './assert.js'

const KEY = 'console-test-key-0123456789'

const MAP = '/\n/invoices\n/invoices/:id\n'

const writeUi = async () => {
  const uiDir = await temporaryDir()
  await Deno.mkdir(`${uiDir}/chunks`)
  await Deno.writeTextFile(`${uiDir}/index.html`, '<!DOCTYPE html><title>console</title>')
  await Deno.writeTextFile(`${uiDir}/chunks/main-1.js`, 'export {}')
  await Deno.writeTextFile(`${await temporaryDir()}/secret.txt`, 'secret')
  return uiDir
}

const startBackend = async () => {
  logger.setQuiet(true)
  const dataDir = await temporaryDir()
  const server = await startServer({
    port: 0,
    adminPort: 0,
    hostname: '127.0.0.1',
    dataDir,
    key: KEY,
    minFree: null,
    segmentMs: 30,
    quiet: true,
  })
  return {
    url: `http://127.0.0.1:${server.adminPort}`,
    collect: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.shutdown()
      await Deno.remove(dataDir, { recursive: true })
    },
  }
}

const open = async () => {
  const backend = await startBackend()
  const serversFile = `${await temporaryDir()}/imp-aly/servers.json`
  addServer({ name: 'one', url: backend.url, auth: KEY }, serversFile)
  const uiDir = await writeUi()
  const running = await startConsole({ port: 0, uiDir, serversFile })
  const base = `http://127.0.0.1:${running.port}`
  const call = async (method, path, body) => {
    const headers = { origin: `http://localhost:${running.port}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  return {
    backend,
    base,
    call,
    serversFile,
    stop: async () => {
      await running.shutdown()
      await backend.stop()
    },
  }
}

Deno.test('the console registers an app, queries it and removes it through a saved server', async () => {
  const { backend, call, stop } = await open()
  try {
    const servers = await call('GET', '/api/servers')
    assertEquals(servers.body.servers, [{ name: 'one', url: backend.url, key: 'saved key' }])
    assert(!JSON.stringify(servers.body).includes(KEY), 'the key must not leave the console')

    const added = await call('PUT', '/api/apps/myapp', { map: MAP, segments: ['plan'], extra: 1 })
    assertEquals(added.status, 200)
    assertEquals(added.body.apps.map(({ server, name, pages }) => [server, name, pages]), [
      ['one', 'myapp', ['/', '/invoices', '/invoices/:id']],
    ])
    const listed = await call('GET', '/api/apps')
    assertEquals(listed.body.apps.map(({ name, segments }) => [name, segments]), [
      ['myapp', ['plan']],
    ])

    const posted = await fetch(`${backend.collect}/collect/myapp`, {
      method: 'POST',
      body: JSON.stringify({ type: 'page', visit: 'v1', at: Date.now(), page: '/' }),
    })
    assertEquals(posted.status, 202)
    await posted.body?.cancel()
    const answer = await waitFor(async () => {
      const result = await call('POST', '/api/query', {
        app: 'myapp',
        groupBy: ['type'],
        measures: ['records', 'visits'],
      })
      return result.body.matched === 1 ? result : null
    })
    assertEquals(answer.body.rows, [{ type: 'page', records: 1, visits: 1 }])
    assertEquals(answer.body.failedServers, [])
    assertEquals(answer.body.warnings, [])

    const bad = await call('POST', '/api/query', { app: 'myapp', measures: ['nope'] })
    assertEquals(bad.status, 400)
    assert(bad.body.error.includes('measures is a list of records and visits'))

    const status = await call('GET', '/api/status?server=one')
    assertEquals([status.body.server, status.body.apps], ['one', 1])

    const removed = await call('DELETE', '/api/apps/myapp')
    assertEquals(removed.body, { removed: ['one'], failedServers: [] })
    assertEquals((await call('GET', '/api/apps/myapp')).status, 404)
  } finally {
    await stop()
  }
})

Deno.test('the console adds up the answers of several servers and names a server that fails', async () => {
  const { call, serversFile, stop } = await open()
  const second = await startBackend()
  try {
    addServer({ name: 'two', url: second.url, auth: KEY }, serversFile)
    addServer({ name: 'down', url: 'http://127.0.0.1:9', auth: KEY }, serversFile)
    const added = await call('PUT', '/api/apps/myapp?servers=one,two,down', { map: MAP })
    assertEquals(added.body.apps.map(({ server }) => server), ['one', 'two'])
    assertEquals(added.body.failedServers.map(({ server }) => server), ['down'])

    const answer = await call('POST', '/api/query?servers=one,two,down', { app: 'myapp' })
    assertEquals(answer.status, 200)
    assertEquals(answer.body.servers.map(({ server }) => server), ['one', 'two'])
    assertEquals(answer.body.failedServers.map(({ server }) => server), ['down'])

    const none = await call('GET', '/api/apps?servers=down')
    assertEquals(none.status, 502)
    const unknown = await call('GET', '/api/apps?servers=nobody')
    assertEquals(unknown.status, 400)

    assertEquals((await call('POST', '/api/servers/two/default')).body, { default: 'two' })
    assertEquals((await call('DELETE', '/api/servers/down')).body.removed, 'down')
    const saved = await call('POST', '/api/servers', { name: 'file', url: 'http://a.example' })
    assertEquals(saved.body, { name: 'file', url: 'http://a.example', key: 'default key file' })
    const invalid = await call('POST', '/api/servers', { name: 'a b', url: 'http://a.example' })
    assertEquals(invalid.status, 400)
  } finally {
    await second.stop()
    await stop()
  }
})

Deno.test('the console answers only on localhost and takes changes only from its page', async () => {
  const uiDir = await writeUi()
  const app = createConsoleApp({
    uiDir,
    serversFile: `${await temporaryDir()}/servers.json`,
    hosts: () => consoleHosts(8010),
  })
  const request = (path, headers = {}, method = 'GET') =>
    app.request(path, { method, headers: { host: 'localhost:8010', ...headers } })

  const page = await request('/')
  assertEquals(page.status, 200)
  assert(page.headers.get('content-security-policy').includes("script-src 'self'"))
  assertEquals(page.headers.get('x-frame-options'), 'DENY')
  assertEquals((await request('/', { host: 'evil.example:8010' })).status, 403)
  assertEquals((await request('/', { host: '127.0.0.1:8010' })).status, 200)
  assertEquals((await request('/api/servers', { 'sec-fetch-site': 'cross-site' })).status, 403)
  const servers = await request('/api/servers')
  assertEquals(servers.status, 200)
  assertEquals(servers.headers.get('cache-control'), 'no-store')

  assertEquals((await request('/api/servers/x/default', {}, 'POST')).status, 403)
  const crossOrigin = { origin: 'http://evil.example' }
  assertEquals((await request('/api/servers/x/default', crossOrigin, 'POST')).status, 403)
  const sameOrigin = { origin: 'http://localhost:8010' }
  const missing = await request('/api/servers/x/default', sameOrigin, 'POST')
  assertEquals(missing.status, 400)
  assertEquals((await missing.json()).error, 'no server named "x" - see imp-aly ls')
  assertEquals((await request('/api/nothing')).status, 404)
})

Deno.test('the page files are served with a fallback for routes and never outside the folder', async () => {
  const uiDir = await writeUi()
  const index = await serveUi(uiDir, '/overview')
  assertEquals(await index.text(), '<!DOCTYPE html><title>console</title>')
  assertEquals(index.headers.get('cache-control'), 'no-cache')
  const chunk = await serveUi(uiDir, '/chunks/main-1.js')
  assertEquals(chunk.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert(chunk.headers.get('cache-control').includes('immutable'))
  await chunk.body?.cancel()
  for (const path of ['/chunks/main-2.js', '/missing.js', '/../secret.txt', '/%2e%2e/secret.txt']) {
    const response = await serveUi(uiDir, path)
    assertEquals(response.status, 404, path)
    await response.body?.cancel()
  }
})

Deno.test('the console does not start without its page, or on a port in use', async () => {
  const empty = await temporaryDir()
  await assertRejects(() => startConsole({ port: 0, uiDir: empty }), /console page is missing/)
  const uiDir = await writeUi()
  const first = await startConsole({ port: 0, uiDir })
  try {
    await assertRejects(() => startConsole({ port: first.port, uiDir }), /is in use/)
  } finally {
    await first.shutdown()
  }
})
