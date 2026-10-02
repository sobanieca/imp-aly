import { createToken, EMPTY_BODY_HASH } from '../src/auth.js'
import { sealDay } from '../src/column-store.js'
import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
import { sha256Hex } from '../src/sha256.js'
import { assert, assertEquals, temporaryDir, waitFor } from './assert.js'
import { DAYS, fill } from './fixtures.js'

const KEY = 'test-key-0123456789'

const MAP = '/\n/invoices\n/invoices/:id\n'

const start = async ({ dataDir: given, ...options } = {}) => {
  logger.setQuiet(true)
  const dataDir = given ?? (await temporaryDir())
  const server = await startServer({
    port: 0,
    adminPort: 0,
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
  const adminBase = `http://127.0.0.1:${server.adminPort}`
  const send = async (root, method, path, body, headers = {}) => {
    const response = await fetch(`${root}${path}`, {
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
  const call = (...args) => send(base, ...args)
  const admin = async (method, path, body, { sign = { method, path, body } } = {}) => {
    const text = (value) =>
      value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value)
    const signed = text(sign.body)
    const bodyHash = signed === undefined
      ? EMPTY_BODY_HASH
      : sha256Hex(new TextEncoder().encode(signed))
    const token = await createToken(KEY, { method: sign.method, path: sign.path, bodyHash })
    return send(adminBase, method, path, text(body), { authorization: `Bearer ${token}` })
  }
  const stop = async ({ keep = false } = {}) => {
    await server.shutdown()
    if (!keep) await Deno.remove(dataDir, { recursive: true })
  }
  return { base, adminBase, call, send, admin, stop, dataDir }
}

const record = (fields) => ({
  visit: 'k3v9a1c2',
  at: Date.now(),
  page: '/invoices/:id',
  ...fields,
})

Deno.test('collects valid records and answers queries', async () => {
  const { adminBase, call, send, admin, stop } = await start()
  try {
    assertEquals((await send(adminBase, 'GET', '/apps')).status, 401)
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
    assertEquals(result.body.groups.map((group) => [group.by[0], group.records]).sort(), [
      ['error', 1],
      ['interaction', 1],
      ['page', 1],
      ['seen', 1],
    ])
    const plans = await admin('POST', '/query', { app: 'myapp', where: { plan: 'pro' } })
    assertEquals(plans.body.groups, [{ by: [], records: 1 }])
    assertEquals(plans.body.appConfig.length, 16)

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
  const { adminBase, call, send, admin, stop } = await start()
  try {
    await admin('PUT', '/apps/myapp', { map: MAP })
    assertEquals((await call('POST', '/collect/other', [])).status, 404)
    assertEquals((await call('POST', '/collect/myapp', '{not json')).status, 400)
    assertEquals((await call('POST', '/collect/myapp', 'x'.repeat(70_000))).status, 413)
    const many = Array.from({ length: 150 }, () => record({ type: 'error' }))
    assertEquals((await call('POST', '/collect/myapp', many)).body, { accepted: 150, rejected: 0 })
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
    const token = await createToken(KEY, { method: 'GET', path: '/apps' })
    const auth = { authorization: `Bearer ${token}` }
    const first = await send(adminBase, 'GET', '/apps', undefined, auth)
    const replay = await send(adminBase, 'GET', '/apps', undefined, auth)
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

Deno.test('the public port and the admin port serve separate endpoints', async () => {
  const { adminBase, call, send, admin, stop } = await start()
  try {
    await admin('PUT', '/apps/myapp', { map: MAP })
    const token = await createToken(KEY, { method: 'GET', path: '/status' })
    const onPublic = await call('GET', '/status', undefined, { authorization: `Bearer ${token}` })
    assertEquals(onPublic.status, 404)
    assertEquals((await send(adminBase, 'POST', '/collect/myapp', [])).status, 404)
    const posted = await call('POST', '/collect/myapp', [record({ type: 'error' })])
    assertEquals(posted.status, 202)
    const status = await admin('GET', '/status')
    assertEquals(status.body.activeRequests, { public: 0, admin: 1 })
    for (const answer of [onPublic, posted, status]) {
      assertEquals(answer.headers.get('x-content-type-options'), 'nosniff')
      assertEquals(
        answer.headers.get('content-security-policy'),
        "default-src 'none'; frame-ancestors 'none'",
      )
    }
  } finally {
    await stop()
  }
})

Deno.test('accepts records only from the allowed origins', async () => {
  const { base, call, admin, stop } = await start({ allowOrigins: ['https://myapp.example'] })
  try {
    await admin('PUT', '/apps/myapp', { map: MAP })
    const batch = [record({ type: 'error' })]
    const allowed = await call('POST', '/collect/myapp', batch, { origin: 'https://myapp.example' })
    assertEquals(allowed.status, 202)
    assertEquals(allowed.headers.get('access-control-allow-origin'), 'https://myapp.example')
    assertEquals(allowed.headers.get('vary'), 'origin')
    const other = await call('POST', '/collect/myapp', batch, { origin: 'https://evil.example' })
    assertEquals(other.status, 403)
    assertEquals(other.headers.get('access-control-allow-origin'), null)
    const opaque = await call('POST', '/collect/myapp', batch, { origin: 'null' })
    assertEquals(opaque.status, 403)
    const preflight = await fetch(`${base}/collect/myapp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    await preflight.body?.cancel()
    assertEquals(preflight.status, 403)
    const direct = await call('POST', '/collect/myapp', batch)
    assertEquals(direct.status, 202)
    assertEquals(direct.headers.get('access-control-allow-origin'), null)
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

Deno.test('a batch above the smallest limit fails, and a refused batch costs one request', async () => {
  const { call, admin, stop } = await start({
    limits: [{ name: '5s', ms: 5_000, limit: 10 }, { name: '1m', ms: 60_000, limit: 50 }],
  })
  try {
    await admin('PUT', '/apps/myapp', { map: MAP })
    const batch = (count) => Array.from({ length: count }, () => record({ type: 'error' }))
    const large = await call('POST', '/collect/myapp', batch(11))
    assertEquals(large.status, 413)
    assertEquals(large.body.error, 'a request holds at most 10 records')
    assertEquals((await call('POST', '/collect/myapp', batch(5))).status, 202)
    assertEquals((await call('POST', '/collect/myapp', batch(5))).status, 429)
    assertEquals((await call('POST', '/collect/myapp', batch(1))).status, 202)
  } finally {
    await stop()
  }
})

Deno.test('answers 503 above the requests in progress', async () => {
  const { base, call, admin, stop } = await start({ maxRequests: 1 })
  try {
    await admin('PUT', '/apps/myapp', { map: MAP })
    let send
    const body = new ReadableStream({ start: (controller) => (send = controller) })
    const slow = fetch(`${base}/collect/myapp`, { method: 'POST', body, duplex: 'half' })
    const rootStatus = async () => {
      const response = await fetch(`${base}/`)
      await response.body?.cancel()
      return response.status
    }
    await waitFor(async () => (await rootStatus()) === 503)
    const busy = await call('POST', '/collect/myapp', [record({ type: 'error' })])
    assertEquals(busy.status, 503)
    assertEquals(busy.headers.get('retry-after'), '5')
    assertEquals(busy.headers.get('access-control-allow-origin'), '*')
    send.enqueue(new TextEncoder().encode(JSON.stringify([record({ type: 'error' })])))
    send.close()
    const done = await slow
    assertEquals(done.status, 202)
    await done.body?.cancel()
    assertEquals(await rootStatus(), 200)
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
      adminPort: 0,
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
    const now = Date.now()
    const earlier = now - 50 * 60_000
    const later = now + 50 * 60_000
    const dayOf = (at) => new Date(at).toISOString().slice(0, 10)
    const days = [...new Set([dayOf(earlier), dayOf(later)])]
    const posted = await call('POST', '/collect/myapp', [
      record({ type: 'error', at: earlier }),
      record({ type: 'error', at: later }),
      record({ type: 'error', at: now - 2 * 3_600_000 }),
    ])
    assertEquals(posted.body, { accepted: 2, rejected: 1 })
    const answer = await waitFor(async () => {
      const result = await admin('POST', '/query', {
        app: 'myapp',
        from: dayOf(earlier),
        to: dayOf(later),
        groupBy: ['day'],
      })
      return result.body.matched === 2 ? result : null
    })
    assertEquals(answer.body.groups.map((group) => group.by[0]).sort(), days)
    for (const day of days) await Deno.stat(`${dataDir}/apps/myapp/${day}`)
  } finally {
    await stop()
  }
})

Deno.test('a token works only for its method, path and body', async () => {
  const { admin, stop } = await start()
  try {
    await admin('PUT', '/apps/myapp', { map: MAP })
    const query = { app: 'myapp' }
    assertEquals((await admin('POST', '/query', query)).status, 200)
    const otherPath = await admin('GET', '/apps', undefined, {
      sign: { method: 'GET', path: '/status' },
    })
    assertEquals(otherPath.status, 401)
    assert(/another request/.test(otherPath.body.error))
    const otherMethod = await admin('DELETE', '/apps/myapp', undefined, {
      sign: { method: 'GET', path: '/apps/myapp' },
    })
    assertEquals(otherMethod.status, 401)
    const otherBody = await admin('POST', '/query', { app: 'other' }, {
      sign: { method: 'POST', path: '/query', body: query },
    })
    assertEquals(otherBody.status, 401)
    assert(/does not match/.test(otherBody.body.error))
    const bodyOnGet = await admin('GET', '/status', undefined, {
      sign: { method: 'GET', path: '/status', body: query },
    })
    assertEquals(bodyOnGet.status, 401)
    const otherSearch = await admin('GET', '/backup?app=myapp', undefined, {
      sign: { method: 'GET', path: '/backup?app=other' },
    })
    assertEquals(otherSearch.status, 401)
    assertEquals((await admin('GET', '/apps/myapp')).status, 200)
  } finally {
    await stop()
  }
})

Deno.test('a backup of one server restores into another', async () => {
  const sourceDir = await fill()
  for (const day of DAYS) await sealDay(`${sourceDir}/apps/myapp/${day}`)
  const source = await start({ dataDir: sourceDir })
  const target = await start()
  try {
    const bytesOf = (body) => typeof body === 'string' ? new TextEncoder().encode(body) : body
    const headers = async (method, path, body) => ({
      authorization: `Bearer ${await createToken(KEY, {
        method,
        path,
        bodyHash: body === undefined ? EMPTY_BODY_HASH : sha256Hex(bytesOf(body)),
      })}`,
    })
    const denied = await fetch(`${source.adminBase}/backup`)
    await denied.body?.cancel()
    assertEquals(denied.status, 401)
    assertEquals((await source.admin('GET', '/backup?from=yesterday')).status, 400)
    const backup = await fetch(`${source.adminBase}/backup?app=myapp`, {
      headers: await headers('GET', '/backup?app=myapp'),
    })
    assertEquals(backup.headers.get('content-type'), 'application/gzip')
    const bytes = new Uint8Array(await backup.arrayBuffer())

    const restore = async (body, signed = body) =>
      fetch(`${target.adminBase}/restore`, {
        method: 'POST',
        headers: await headers('POST', '/restore', signed),
        body,
      })
    const forged = await restore(bytes, 'another body')
    assertEquals(forged.status, 401)
    assert(/does not match/.test((await forged.json()).error))
    const posted = await restore(bytes)
    assertEquals(posted.status, 200)
    assertEquals((await posted.json()).restored.length, 2)
    assertEquals((await (await restore(bytes)).json()).skipped.length, 2)
    const broken = await restore('not a backup')
    assertEquals(broken.status, 400)
    assert(/not valid/.test((await broken.json()).error))

    const query = { app: 'myapp', from: DAYS[0], to: DAYS[1], groupBy: ['page'] }
    const expected = await source.admin('POST', '/query', query)
    const answered = await target.admin('POST', '/query', query)
    assertEquals(answered.body, expected.body)
    assertEquals(answered.body.summaryDays, 2)
  } finally {
    await source.stop()
    await target.stop()
  }
})
