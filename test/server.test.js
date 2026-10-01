import { createToken } from '../src/auth.js'
import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
import { assertEquals, temporaryDir, waitFor } from './assert.js'

const KEY = 'test-key-0123456789'

const MAP = '/\n/invoices\n/invoices/:id\n'

const start = async ({ dataDir: given, ...options } = {}) => {
  logger.setQuiet(true)
  const dataDir = given ?? (await temporaryDir())
  const server = await startServer({
    port: 0,
    hostname: '127.0.0.1',
    dataDir,
    key: KEY,
    minFree: null,
    segmentMs: 30,
    quiet: true,
    fetchMap: (url) => {
      if (url === 'https://myapp.example/app-map.txt') {
        return Promise.resolve(MAP.split('\n').filter(Boolean))
      }
      return Promise.reject(new Error('not found'))
    },
    ...options,
  })
  const base = `http://127.0.0.1:${server.port}`
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    }
  }
  const admin = async (method, path, body) =>
    call(method, path, body, { authorization: `Bearer ${await createToken(KEY)}` })
  const stop = async ({ keep = false } = {}) => {
    await server.shutdown()
    if (!keep) await Deno.remove(dataDir, { recursive: true })
  }
  return { base, call, admin, stop, dataDir }
}

const record = (fields) => ({
  visit: 'k3v9a1c2',
  at: Date.now(),
  page: '/invoices/:id',
  ...fields,
})

Deno.test('collects valid records and answers queries', async () => {
  const { call, admin, stop } = await start()
  try {
    assertEquals((await call('GET', '/apps')).status, 401)
    const added = await admin('PUT', '/apps/myapp', { map: MAP, segments: ['plan'] })
    assertEquals(added.status, 200)
    assertEquals(added.body.pages, 3)

    const posted = await call('POST', '/collect/myapp', [
      record({ type: 'page', readyMs: 420, plan: 'pro' }),
      record({ type: 'seen', zone: 'myapp.send' }),
      record({ type: 'interaction', zone: null }),
      record({ type: 'page', readyMs: 1, page: '/admin' }),
    ])
    assertEquals(posted.status, 202)
    assertEquals(posted.body, { accepted: 3, rejected: 1 })
    assertEquals(posted.headers.get('access-control-allow-origin'), '*')

    const single = await call('POST', '/collect/myapp', JSON.stringify(record({ type: 'error' })), {
      'content-type': 'text/plain;charset=UTF-8',
    })
    assertEquals(single.body, { accepted: 1, rejected: 0 })

    const result = await waitFor(async () => {
      const answer = await admin('POST', '/query', {
        app: 'myapp',
        groupBy: ['type'],
        measures: ['records', 'visits'],
      })
      return answer.body.matched === 4 ? answer : null
    })
    assertEquals(result.body.rows.map((row) => [row.type, row.records]).sort(), [
      ['error', 1],
      ['interaction', 1],
      ['page', 1],
      ['seen', 1],
    ])
    const plans = await admin('POST', '/query', { app: 'myapp', where: { plan: 'pro' } })
    assertEquals(plans.body.rows, [{ records: 1 }])

    const apps = await admin('GET', '/apps')
    assertEquals(apps.body.apps[0].accepted, 4)
    assertEquals(apps.body.apps[0].rejections, { 'page is not on the app map': 1 })
    const status = await admin('GET', '/status')
    assertEquals(status.status, 200)
  } finally {
    await stop()
  }
})

Deno.test('rejects malformed and oversized requests', async () => {
  const { call, admin, stop } = await start()
  try {
    await admin('PUT', '/apps/myapp', { map: MAP })
    assertEquals((await call('POST', '/collect/other', [])).status, 404)
    assertEquals((await call('POST', '/collect/myapp', '{not json')).status, 400)
    assertEquals((await call('POST', '/collect/myapp', 'x'.repeat(70_000))).status, 413)
    const many = Array.from({ length: 101 }, () => record({ type: 'error' }))
    assertEquals((await call('POST', '/collect/myapp', many)).status, 413)
    assertEquals((await call('GET', '/collect/myapp')).status, 405)
    assertEquals((await call('GET', '/nothing')).status, 404)
    assertEquals((await admin('PUT', '/apps/Bad_Name', { map: MAP })).status, 400)
    assertEquals((await admin('PUT', '/apps/x', { map: 'no-slash' })).status, 422)
    assertEquals(
      (await admin('PUT', '/apps/x', { mapUrl: 'https://nowhere.example/' })).status,
      422,
    )
    assertEquals((await admin('PUT', '/apps/x', { map: MAP, segments: ['page'] })).status, 400)
    assertEquals((await admin('PUT', '/apps/x', { map: MAP, segments: ['Page'] })).status, 400)
    assertEquals(
      (await admin('PUT', '/apps/x', { map: MAP, segments: ['plan', 'Plan'] })).status,
      400,
    )
    assertEquals((await admin('POST', '/query', { app: 'myapp', measures: ['nope'] })).status, 400)
    const token = await createToken(KEY)
    const first = await call('GET', '/apps', undefined, { authorization: `Bearer ${token}` })
    const replay = await call('GET', '/apps', undefined, { authorization: `Bearer ${token}` })
    assertEquals([first.status, replay.status], [200, 401])
  } finally {
    await stop()
  }
})

Deno.test('answers a CORS preflight and registers an app from a URL', async () => {
  const { base, admin, stop } = await start()
  try {
    const response = await fetch(`${base}/collect/myapp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://myapp.example', 'access-control-request-method': 'POST' },
    })
    await response.body?.cancel()
    assertEquals(response.status, 204)
    assertEquals(response.headers.get('access-control-allow-methods'), 'POST')
    const added = await admin('PUT', '/apps/myapp', { mapUrl: 'https://myapp.example/app-map.txt' })
    assertEquals(added.body.mapUrl, 'https://myapp.example/app-map.txt')
    assertEquals((await admin('POST', '/apps/myapp/refresh')).body.mapError, null)
    assertEquals((await admin('DELETE', '/apps/myapp')).status, 200)
    assertEquals((await admin('GET', '/apps')).body.apps, [])
  } finally {
    await stop()
  }
})

Deno.test('drops requests of an address over the limit', async () => {
  const { call, admin, stop } = await start({
    limits: [{ name: '5s', ms: 5_000, limit: 10 }],
  })
  try {
    await admin('PUT', '/apps/myapp', { map: MAP })
    const batch = Array.from({ length: 5 }, () => record({ type: 'error' }))
    assertEquals((await call('POST', '/collect/other-ip', [])).status, 404)
    assertEquals((await call('POST', '/collect/myapp', batch.slice(1))).status, 202)
    const over = await call('POST', '/collect/myapp', batch)
    assertEquals(over.status, 429)
    const blocked = await call('POST', '/collect/myapp', batch)
    assertEquals(blocked.status, 429)
    assertEquals(blocked.headers.get('access-control-allow-origin'), '*')
  } finally {
    await stop()
  }
})

Deno.test('the registry and the data survive a restart', async () => {
  const first = await start()
  await first.admin('PUT', '/apps/myapp', { map: MAP })
  await first.call('POST', '/collect/myapp', [record({ type: 'error' })])
  await first.stop({ keep: true })
  const second = await start({ dataDir: first.dataDir })
  try {
    assertEquals((await second.admin('GET', '/apps')).body.apps.map((app) => app.name), ['myapp'])
    assertEquals(
      (await second.call('POST', '/collect/myapp', [record({ type: 'error' })])).status,
      202,
    )
    await waitFor(async () => {
      const answer = await second.admin('POST', '/query', { app: 'myapp' })
      return answer.body.matched === 2
    })
  } finally {
    await second.stop()
  }
})

Deno.test('a second server on the same data folder fails', async () => {
  const first = await start()
  try {
    const error = await startServer({
      port: 0,
      hostname: '127.0.0.1',
      dataDir: first.dataDir,
      key: KEY,
      minFree: null,
      quiet: true,
    }).catch((reason) => reason)
    assertEquals(/already uses the data folder/.test(error.message), true)
  } finally {
    await first.stop()
  }
})

Deno.test('a record goes to the UTC day of its at', async () => {
  const { call, admin, stop, dataDir } = await start()
  try {
    await admin('PUT', '/apps/myapp', { map: MAP })
    const today = new Date().toISOString().slice(0, 10)
    const lastMsOfYesterday = Date.parse(today) - 1
    const yesterday = new Date(lastMsOfYesterday).toISOString().slice(0, 10)
    const posted = await call('POST', '/collect/myapp', [
      record({ type: 'error', at: lastMsOfYesterday }),
      record({ type: 'error' }),
      record({ type: 'error', at: Date.now() - 2 * 86_400_000 }),
    ])
    assertEquals(posted.body, { accepted: 2, rejected: 1 })
    const answer = await waitFor(async () => {
      const result = await admin('POST', '/query', {
        app: 'myapp',
        from: yesterday,
        to: today,
        groupBy: ['day'],
      })
      return result.body.matched === 2 ? result : null
    })
    assertEquals(answer.body.rows.map((row) => row.day).sort(), [today, yesterday].sort())
    await Deno.stat(`${dataDir}/apps/myapp/${yesterday}`)
  } finally {
    await stop()
  }
})
