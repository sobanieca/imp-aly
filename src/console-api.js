import { Hono } from 'hono'
import {
  ApiError,
  DEFAULT_URL,
  eachServer,
  fetchServer,
  queryServers,
  resolveOne,
  resolveTargets,
} from './api-client.js'
import { removeIfExists } from './fs-utils.js'
import { logger } from './logger.js'
import { QueryError } from './query.js'
import { addServer, keyLabel, loadServers, removeServer, useServer } from './servers.js'
import { hashStream } from './sha256.js'
import { serveUi } from './static-files.js'
import { version } from './version.js'

const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
}

const SAFE_METHODS = ['GET', 'HEAD']

const USER_ERRORS = [Error, ApiError, QueryError]

export const consoleHosts = (port) =>
  new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])

const statusOf = (error) => {
  if (error instanceof ApiError) {
    return error.status >= 400 && error.status < 500 ? error.status : 502
  }
  return error.status ?? 400
}

const readJsonBody = async (c) => {
  try {
    return await c.req.json()
  } catch {
    throw new Error('the body is not valid JSON')
  }
}

const serverList = (value) => (value ? value : undefined)

const runEach = async (targets, run) => {
  const { results, failed } = await eachServer(targets, run)
  if (!results.length && failed.length) {
    throw new ApiError(
      `no server answered:\n${failed.map((entry) => `  ${entry.reason}`).join('\n')}`,
      502,
    )
  }
  return { results, failedServers: failed }
}

const appBody = (body) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('the body is an object, like {"mapUrl": "https://myapp.example/app-map.txt"}')
  }
  const result = {}
  for (const key of ['mapUrl', 'map', 'segments']) {
    if (body[key] !== undefined) result[key] = body[key]
  }
  return result
}

const fileLabel = (label) => label.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9._-]+/g, '-')

export const createConsoleApp = ({ uiDir, hosts, serversFile }) => {
  const app = new Hono()
  const targets = (c) => resolveTargets({ server: serverList(c.req.query('servers')) }, serversFile)
  const target = (c) => resolveOne({ server: serverList(c.req.query('server')) }, serversFile)
  const appPath = (c, suffix = '') => `/apps/${encodeURIComponent(c.req.param('name'))}${suffix}`

  app.use('*', async (c, next) => {
    const allowed = hosts()
    if (!allowed.has(c.req.header('host') ?? '')) {
      return c.json({ error: 'the console answers only on localhost' }, 403)
    }
    if (c.req.path.startsWith('/api')) {
      if (c.req.header('sec-fetch-site') === 'cross-site') {
        return c.json({ error: 'the console API takes no request from another site' }, 403)
      }
      if (!SAFE_METHODS.includes(c.req.method)) {
        const origin = c.req.header('origin') ?? ''
        const host = origin.replace(/^http:\/\//, '')
        if (!origin.startsWith('http://') || !allowed.has(host)) {
          return c.json({ error: 'the console API takes changes only from the console page' }, 403)
        }
      }
    }
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value)
    if (c.req.path.startsWith('/api')) c.res.headers.set('cache-control', 'no-store')
  })

  app.onError((error, c) => {
    if (!USER_ERRORS.includes(error.constructor)) {
      logger.error(error)
      return c.json({ error: 'internal error' }, 500)
    }
    return c.json({ error: error.message }, statusOf(error))
  })

  app.get('/api', (c) => c.json({ name: 'imp-aly', version, localUrl: DEFAULT_URL }))

  app.get('/api/servers', (c) => {
    const store = loadServers(serversFile)
    return c.json({
      default: store.default,
      localUrl: DEFAULT_URL,
      servers: store.servers.map(({ name, url, auth }) => ({ name, url, key: keyLabel(auth) })),
    })
  })

  app.post('/api/servers', async (c) => {
    const body = await readJsonBody(c)
    const saved = addServer(
      { name: body?.name, url: body?.url, auth: body?.auth || undefined },
      serversFile,
    )
    return c.json({ name: saved.name, url: saved.url, key: keyLabel(saved.auth) })
  })

  app.post('/api/servers/:name/default', (c) => {
    const found = useServer(c.req.param('name'), serversFile)
    return c.json({ default: found.name })
  })

  app.delete('/api/servers/:name', (c) => {
    const removed = removeServer(c.req.param('name'), serversFile)
    return c.json({ removed: removed.name, default: loadServers(serversFile).default })
  })

  app.get('/api/status', async (c) => {
    const one = target(c)
    const response = await fetchServer(one, { method: 'GET', path: '/status' })
    return c.json({ server: one.label, url: one.url, ...(await response.json()) })
  })

  app.get('/api/apps', async (c) => {
    const { results, failedServers } = await runEach(targets(c), (call) => call('GET', '/apps'))
    const apps = results.flatMap(({ server, result }) =>
      result.apps.map((entry) => ({ server, ...entry }))
    )
    return c.json({ apps, failedServers })
  })

  app.get('/api/apps/:name', async (c) => {
    const { results, failedServers } = await runEach(targets(c), (call) => call('GET', appPath(c)))
    return c.json({
      apps: results.map(({ server, result }) => ({ server, ...result })),
      failedServers,
    })
  })

  app.put('/api/apps/:name', async (c) => {
    const body = appBody(await readJsonBody(c))
    const { results, failedServers } = await runEach(
      targets(c),
      (call) => call('PUT', appPath(c), body),
    )
    return c.json({
      apps: results.map(({ server, result }) => ({ server, ...result })),
      failedServers,
    })
  })

  app.post('/api/apps/:name/refresh', async (c) => {
    const { results, failedServers } = await runEach(
      targets(c),
      (call) => call('POST', appPath(c, '/refresh')),
    )
    return c.json({
      apps: results.map(({ server, result }) => ({ server, ...result })),
      failedServers,
    })
  })

  app.delete('/api/apps/:name', async (c) => {
    const { results, failedServers } = await runEach(
      targets(c),
      (call) => call('DELETE', appPath(c)),
    )
    return c.json({ removed: results.map(({ server }) => server), failedServers })
  })

  app.post('/api/query', async (c) => {
    const { result, warnings } = await queryServers(targets(c), await readJsonBody(c))
    return c.json({ ...result, warnings })
  })

  app.get('/api/backup', async (c) => {
    const one = target(c)
    const params = new URLSearchParams()
    for (const name of ['app', 'from', 'to']) {
      const value = c.req.query(name)
      if (value) params.set(name, value)
    }
    const response = await fetchServer(one, {
      method: 'GET',
      path: params.size ? `/backup?${params}` : '/backup',
    })
    const day = new Date().toISOString().slice(0, 10)
    return new Response(response.body, {
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="imp-aly-backup-${
          fileLabel(one.label)
        }-${day}.tar.gz"`,
      },
    })
  })

  app.post('/api/restore', async (c) => {
    const one = target(c)
    const body = c.req.raw.body
    if (!body) throw new Error('send the backup file as the body')
    const file = await Deno.makeTempFile({ prefix: 'imp-aly-restore-', suffix: '.tar.gz' })
    try {
      const output = await Deno.open(file, { write: true, truncate: true })
      await body.pipeTo(output.writable)
      const bodyHash = await hashStream((await Deno.open(file)).readable)
      const input = await Deno.open(file)
      const response = await fetchServer(one, {
        method: 'POST',
        path: '/restore',
        body: input.readable,
        bodyHash,
        contentType: 'application/gzip',
      })
      return c.json(await response.json())
    } finally {
      await removeIfExists(file)
    }
  })

  app.all(
    '/api/*',
    (c) => c.json({ error: `${c.req.method} ${c.req.path} is not an endpoint` }, 404),
  )

  app.get('*', (c) => serveUi(uiDir, c.req.path))

  return app
}
