import { createToken, EMPTY_BODY_HASH } from '../src/token.js'
import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
import { sha256Hex } from '../src/sha256.js'
import { assert, assertEquals, temporaryDir, waitFor } from './assert.js'
import { DAYS, fill, sealAll } from './fixtures.js'

const KEY = 'test-key-0123456789'

const PAGES = ['/', '/invoices', '/invoices/:id']

const buildText = (lists) =>
  JSON.stringify({
    pages: PAGES,
    zones: ['myapp.list', 'myapp.send'],
    outcomes: ['myapp.sent'],
    ...lists,
  })

const BUILD = { build: buildText() }

const BUILD_URL = 'https://myapp.example/app-analytics.json'

const APP_URL = 'https://myapp.example/'

const hostedFiles = () => ({ [BUILD_URL]: BUILD.build })

const start = async ({ dataDir: given, files = hostedFiles(), ...options } = {}) => {
  logger.setQuiet(true)
  const fetched = []
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
    fetchFile: (url) => {
      fetched.push(url)
      if (Object.hasOwn(files, url)) return Promise.resolve(files[url])
      return Promise.reject(new Error(`GET ${url} answered 404`))
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
  return {
    base,
    adminBase,
    call,
    send,
    admin,
    stop,
    dataDir,
    files,
    fetched,
    setKey: server.setKey,
  }
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
    const added = await admin('PUT', '/apps/myapp', { ...BUILD, segments: ['plan'] })
    assertEquals(added.status, 200)
    assertEquals(added.body.pages.length, 3)
    assertEquals(added.body.zones, ['myapp.list', 'myapp.send'])
    assertEquals(added.body.outcomes, ['myapp.sent'])

    const posted = await call('POST', '/collect/myapp', [
      record({ type: 'page', plan: 'pro' }),
      record({ type: 'seen', zone: 'myapp.send' }),
      record({ type: 'used', zone: null }),
      record({ type: 'page', page: '/admin' }),
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
      ['page', 1],
      ['seen', 1],
      ['used', 1],
    ])
    const plans = await admin('POST', '/query', { app: 'myapp', where: { plan: 'pro' } })
    assertEquals(plans.body.groups, [{ by: [], records: 1 }])
    assertEquals(plans.body.appConfig.length, 16)

    const apps = await admin('GET', '/apps')
    assertEquals(apps.body.apps[0].accepted, 4)
    assertEquals(apps.body.apps[0].rejections, {
      'page is not in the pages of app-analytics.json': 1,
    })
    const status = await admin('GET', '/status')
    assertEquals(status.status, 200)
  } finally {
    await stop()
  }
})

Deno.test('a server keeps its source id in the data folder over a restart', async () => {
  const first = await start()
  const { body } = await first.admin('GET', '/status')
  assert(/^[0-9a-f]{16}$/.test(body.source))
  const stored = JSON.parse(await Deno.readTextFile(`${first.dataDir}/source.json`))
  assertEquals(stored.source, body.source)
  await first.stop({ keep: true })
  const second = await start({ dataDir: first.dataDir })
  try {
    assertEquals((await second.admin('GET', '/status')).body.source, body.source)
  } finally {
    await second.stop()
  }
})

Deno.test('a removed app keeps its records, and a new registration brings them back', async () => {
  const { call, admin, stop } = await start()
  try {
    await admin('PUT', '/apps/myapp', { ...BUILD, segments: ['plan'] })
    await call('POST', '/collect/myapp', [
      record({ type: 'page', plan: 'pro' }),
      record({ type: 'page', plan: 'free' }),
    ])
    const count = async () =>
      (await admin('POST', '/query', { app: 'myapp' })).body.groups[0]?.records ?? 0
    await waitFor(async () => (await count()) === 2)
    assertEquals((await admin('DELETE', '/apps/myapp')).body, { removed: 'myapp' })
    assertEquals((await admin('GET', '/apps')).body.apps, [])
    assertEquals((await call('POST', '/collect/myapp', [record({ type: 'page' })])).status, 404)
    assertEquals(await count(), 2)
    await admin('PUT', '/apps/myapp', { ...BUILD, segments: ['plan'] })
    assertEquals(await count(), 2)
    const plans = await admin('POST', '/query', { app: 'myapp', where: { plan: 'pro' } })
    assertEquals(plans.body.groups, [{ by: [], records: 1 }])
  } finally {
    await stop()
  }
})

Deno.test('rejects malformed and oversized requests', async () => {
  const { adminBase, call, send, admin, stop } = await start()
  try {
    await admin('PUT', '/apps/myapp', BUILD)
    assertEquals((await call('POST', '/collect/other', [])).status, 404)
    assertEquals((await call('POST', '/collect/myapp', '{not json')).status, 400)
    assertEquals((await call('POST', '/collect/myapp', 'x'.repeat(70_000))).status, 413)
    const many = Array.from({ length: 150 }, () => record({ type: 'error' }))
    assertEquals((await call('POST', '/collect/myapp', many)).body, { accepted: 150, rejected: 0 })
    assertEquals((await call('GET', '/collect/myapp')).status, 405)
    assertEquals((await call('GET', '/nothing')).status, 404)
    assertEquals((await admin('PUT', '/apps/Bad_Name', BUILD)).status, 400)
    assertEquals(
      (await admin('PUT', '/apps/x', { build: buildText({ pages: ['no-slash'] }) })).status,
      422,
    )
    assertEquals((await admin('PUT', '/apps/x', { build: '{' })).status, 422)
    assertEquals((await admin('PUT', '/apps/x', { build: { pages: PAGES } })).status, 400)
    assertEquals((await admin('PUT', '/apps/x', { segments: [] })).status, 400)
    assertEquals((await admin('PUT', '/apps/x', { ...BUILD, appUrl: APP_URL })).status, 400)
    assertEquals((await admin('PUT', '/apps/x', { appUrl: 'myapp.example' })).status, 400)
    assertEquals(
      (await admin('PUT', '/apps/x', { appUrl: 'https://nowhere.example/' })).status,
      422,
    )
    assertEquals((await admin('PUT', '/apps/x', { ...BUILD, segments: ['page'] })).status, 400)
    assertEquals((await admin('PUT', '/apps/x', { ...BUILD, segments: ['Page'] })).status, 400)
    for (const segment of ['week', 'constructor', 'toString']) {
      assertEquals((await admin('PUT', '/apps/x', { ...BUILD, segments: [segment] })).status, 400)
    }
    assertEquals(
      (await admin('PUT', '/apps/x', { ...BUILD, segments: ['plan', 'Plan'] })).status,
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

Deno.test('a new key works at once and the old key stops, while the server runs', async () => {
  const server = await start()
  const status = async (key) => {
    const token = await createToken(key, { method: 'GET', path: '/status' })
    return (await server.send(server.adminBase, 'GET', '/status', undefined, {
      authorization: `Bearer ${token}`,
    })).status
  }
  try {
    assertEquals(await status(KEY), 200)
    server.setKey('next-key-0123456789')
    assertEquals(await status(KEY), 401)
    assertEquals(await status('next-key-0123456789'), 200)
    assertEquals((await server.call('POST', '/collect/other', [])).status, 404)
    let problem = null
    try {
      server.setKey('')
    } catch (error) {
      problem = error.message
    }
    assertEquals(problem, 'the server needs a key')
    assertEquals(await status('next-key-0123456789'), 200)
  } finally {
    await server.stop()
  }
})

Deno.test('answers a CORS preflight and registers an app from a URL', async () => {
  const { base, admin, stop, fetched } = await start()
  try {
    const response = await fetch(`${base}/collect/myapp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://myapp.example', 'access-control-request-method': 'POST' },
    })
    await response.body?.cancel()
    assertEquals(response.status, 204)
    assertEquals(response.headers.get('access-control-allow-methods'), 'POST')
    const added = await admin('PUT', '/apps/myapp', { appUrl: 'https://myapp.example' })
    assertEquals(added.body.appUrl, APP_URL)
    assertEquals(added.body.zones, ['myapp.list', 'myapp.send'])
    assertEquals(added.body.outcomes, ['myapp.sent'])
    assertEquals(fetched, [BUILD_URL])
    assertEquals((await admin('POST', '/apps/myapp/refresh')).body.buildError, null)
    assertEquals(fetched, [BUILD_URL, BUILD_URL])
    assertEquals((await admin('DELETE', '/apps/myapp')).status, 200)
    assertEquals((await admin('GET', '/apps')).body.apps, [])
  } finally {
    await stop()
  }
})

Deno.test('a failed refresh keeps the last build file and records the error', async () => {
  const { admin, call, stop, files } = await start()
  try {
    await admin('PUT', '/apps/myapp', { appUrl: APP_URL })
    delete files[BUILD_URL]
    const failed = await admin('POST', '/apps/myapp/refresh')
    assertEquals(failed.body.buildError, `GET ${BUILD_URL} answered 404`)
    assertEquals(failed.body.zones, ['myapp.list', 'myapp.send'])
    assertEquals(failed.body.outcomes, ['myapp.sent'])
    files[BUILD_URL] = buildText({ zones: ['myapp.new'], outcomes: ['myapp.sent', 'bad line'] })
    const bad = await admin('POST', '/apps/myapp/refresh')
    assertEquals(
      bad.body.buildError,
      'app-analytics.json outcomes[1] "bad line" is not an outcome name - a namespaced name, like myapp.sent',
    )
    assertEquals(bad.body.zones, ['myapp.list', 'myapp.send'])
    const posted = await call('POST', '/collect/myapp', [
      record({ type: 'seen', zone: 'myapp.send' }),
      record({ type: 'seen', zone: 'myapp.new' }),
    ])
    assertEquals(posted.body, { accepted: 1, rejected: 1 })
    files[BUILD_URL] = buildText({ zones: ['myapp.new'], outcomes: [] })
    const fixed = await admin('POST', '/apps/myapp/refresh')
    assertEquals([fixed.body.buildError, fixed.body.zones, fixed.body.outcomes], [
      null,
      ['myapp.new'],
      [],
    ])
    const rejected = await admin('PUT', '/apps/other', {
      build: buildText({ zones: ['myapp.send', 'noname'] }),
    })
    assertEquals(rejected.status, 422)
    assertEquals(
      rejected.body.error,
      'app-analytics.json zones[1] "noname" is not a zone name - a namespaced name, like myapp.send',
    )
  } finally {
    await stop()
  }
})

Deno.test('rejects the zones and outcomes that are not in the build file', async () => {
  const { admin, call, stop } = await start()
  try {
    await admin('PUT', '/apps/myapp', BUILD)
    const posted = await call('POST', '/collect/myapp', [
      record({ type: 'seen', zone: 'myapp.send' }),
      record({ type: 'used', zone: 'myapp.list' }),
      record({ type: 'used', zone: null }),
      record({ type: 'outcome', name: 'myapp.sent' }),
      record({ type: 'seen', zone: 'myapp.forged' }),
      record({ type: 'used', zone: 'myapp.forged' }),
      record({ type: 'outcome', name: 'myapp.forged' }),
    ])
    assertEquals(posted.body, { accepted: 4, rejected: 3 })
    const shown = await admin('GET', '/apps/myapp')
    assertEquals(shown.body.rejections, {
      'zone is not in the zones of app-analytics.json': 2,
      'name is not in the outcomes of app-analytics.json': 1,
    })
    const empty = await admin('PUT', '/apps/empty', {
      build: buildText({ zones: [], outcomes: [] }),
    })
    assertEquals([empty.status, empty.body.zones, empty.body.outcomes], [200, [], []])
    const none = await call('POST', '/collect/empty', [
      record({ type: 'used', zone: null }),
      record({ type: 'seen', zone: 'myapp.send' }),
      record({ type: 'outcome', name: 'myapp.sent' }),
    ])
    assertEquals(none.body, { accepted: 1, rejected: 2 })
  } finally {
    await stop()
  }
})

Deno.test('the public port and the admin port serve separate endpoints', async () => {
  const { adminBase, call, send, admin, stop } = await start()
  try {
    await admin('PUT', '/apps/myapp', BUILD)
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
    await admin('PUT', '/apps/myapp', BUILD)
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
    await admin('PUT', '/apps/myapp', BUILD)
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
    await admin('PUT', '/apps/myapp', BUILD)
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
    await admin('PUT', '/apps/myapp', BUILD)
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

Deno.test('one address holds only its share of the requests in progress', async () => {
  const { base, call, admin, stop } = await start({ maxRequests: 8, maxClientRequests: 2 })
  try {
    await admin('PUT', '/apps/myapp', BUILD)
    const senders = []
    const open = () => {
      let send
      const body = new ReadableStream({ start: (controller) => (send = controller) })
      const response = fetch(`${base}/collect/myapp`, { method: 'POST', body, duplex: 'half' })
      senders.push({ send: () => send, response })
    }
    open()
    open()
    const rootStatus = async () => {
      const response = await fetch(`${base}/`)
      await response.body?.cancel()
      return response.status
    }
    await waitFor(async () => (await rootStatus()) === 429)
    const refused = await call('POST', '/collect/myapp', [record({ type: 'error' })])
    assertEquals(refused.status, 429)
    assertEquals(refused.body.error, 'too many requests in progress from this address')
    assertEquals(refused.headers.get('retry-after'), '5')
    for (const sender of senders) {
      sender.send().enqueue(new TextEncoder().encode(JSON.stringify([record({ type: 'error' })])))
      sender.send().close()
      const done = await sender.response
      assertEquals(done.status, 202)
      await done.body?.cancel()
    }
    assertEquals(await rootStatus(), 200)
  } finally {
    await stop()
  }
})

Deno.test('a collect body that is too slow gets 408 and frees its place', async () => {
  const { base, call, admin, stop } = await start({ collectTimeoutMs: 150 })
  try {
    await admin('PUT', '/apps/myapp', BUILD)
    let sender
    const body = new ReadableStream({
      start: (controller) => {
        sender = controller
        controller.enqueue(new TextEncoder().encode('['))
      },
    })
    const slow = await fetch(`${base}/collect/myapp`, { method: 'POST', body, duplex: 'half' })
    assertEquals(slow.status, 408)
    await slow.body?.cancel()
    sender.close()
    assertEquals((await call('POST', '/collect/myapp', [record({ type: 'error' })])).status, 202)
    assertEquals((await admin('GET', '/status')).body.activeRequests, { public: 0, admin: 1 })
  } finally {
    await stop()
  }
})

Deno.test('a restore upload that stops sending gets 408 and leaves no file', async () => {
  const { adminBase, dataDir, stop } = await start({ restoreIdleMs: 150 })
  try {
    const token = await createToken(KEY, {
      method: 'POST',
      path: '/restore',
      bodyHash: sha256Hex(new TextEncoder().encode('never sent')),
    })
    let sender
    const body = new ReadableStream({
      start: (controller) => {
        sender = controller
        controller.enqueue(new TextEncoder().encode('half'))
      },
    })
    const stalled = await fetch(`${adminBase}/restore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body,
      duplex: 'half',
    })
    assertEquals(stalled.status, 408)
    assert(/no bytes for 0.15 s/.test((await stalled.json()).error))
    sender.close()
    assertEquals([...Deno.readDirSync(`${dataDir}/restore`)], [])
  } finally {
    await stop()
  }
})

Deno.test('a second server cannot take a port that a server uses', async () => {
  const first = await start()
  const dataDir = await temporaryDir()
  try {
    const error = await startServer({
      port: Number(new URL(first.base).port),
      adminPort: 0,
      hostname: '127.0.0.1',
      dataDir,
      key: KEY,
      minFree: null,
      quiet: true,
    }).catch((reason) => reason)
    assert(error instanceof Deno.errors.AddrInUse, String(error))
  } finally {
    await first.stop()
    await Deno.remove(dataDir, { recursive: true })
  }
})

Deno.test('the registry and the data survive a restart', async () => {
  const first = await start()
  await first.admin('PUT', '/apps/myapp', BUILD)
  await first.call('POST', '/collect/myapp', [record({ type: 'error' })])
  await first.stop({ keep: true })
  const second = await start({ dataDir: first.dataDir })
  try {
    assertEquals(
      (await second.admin('GET', '/apps')).body.apps.map((app) => [app.name, app.zones]),
      [['myapp', ['myapp.list', 'myapp.send']]],
    )
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
    await admin('PUT', '/apps/myapp', BUILD)
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
    await admin('PUT', '/apps/myapp', BUILD)
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
    const otherSearch = await admin('GET', '/backup?by=week', undefined, {
      sign: { method: 'GET', path: '/backup?by=month' },
    })
    assertEquals(otherSearch.status, 401)
    assertEquals((await admin('GET', '/apps/myapp')).status, 200)
  } finally {
    await stop()
  }
})

Deno.test('a backup of one server restores into another', async () => {
  const sourceDir = await fill()
  await sealAll(sourceDir)
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
    assertEquals((await source.admin('GET', '/backup?last=yesterday')).status, 400)
    assertEquals((await source.admin('GET', '/backup?app=myapp')).status, 400)
    const backup = await fetch(`${source.adminBase}/backup?last=all&by=day`, {
      headers: await headers('GET', '/backup?last=all&by=day'),
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

Deno.test('the admin port lets a page of any origin call it with a signed token', async () => {
  const { adminBase, send, admin, stop } = await start()
  try {
    const preflight = await fetch(`${adminBase}/query`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://console.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    })
    await preflight.body?.cancel()
    assertEquals(preflight.status, 204)
    assertEquals(preflight.headers.get('access-control-allow-origin'), '*')
    assert(preflight.headers.get('access-control-allow-headers').includes('authorization'))
    assert(preflight.headers.get('access-control-allow-methods').includes('DELETE'))
    const status = await admin('GET', '/status')
    assertEquals(status.status, 200)
    assertEquals(status.headers.get('access-control-allow-origin'), '*')
    const refused = await send(adminBase, 'GET', '/apps')
    assertEquals(refused.status, 401)
    assertEquals(refused.headers.get('access-control-allow-origin'), '*')
  } finally {
    await stop()
  }
})
