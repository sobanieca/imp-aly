import { appConfig, AppError, openApps } from './apps.js'
import { createTokenVerifier, EMPTY_BODY_HASH } from './token.js'
import { BackupError, createBackupStream, parseBackupOptions } from './backup.js'
import { checkDataFormat, DATA_FORMAT } from './data-format.js'
import { dayOf } from './days.js'
import { removeIfExists } from './fs-utils.js'
import { watchFiles } from './file-watch.js'
import { HttpError, parseJsonBytes, readBodyBytes, readJsonBody } from './http-body.js'
import { logger } from './logger.js'
import { createOriginCheck } from './origins.js'
import { isAppName } from './names.js'
import { join } from './paths.js'
import { createSha256, sha256Hex } from './sha256.js'
import { openSource } from './source.js'
import { parseQuery, QueryError } from './query-core.js'
import {
  clientAddress,
  clientKeys,
  createRateLimiter,
  DEFAULT_LIMITS,
  DEFAULT_TRUSTED_PROXIES,
  maxBatch,
  parseTrustedProxies,
} from './rate-limit.js'
import { normalizeCountry, validateRecord } from './records.js'
import { DEFAULT_MIN_FREE, parseMinFree } from './retention.js'
import { version } from './version.js'
import { openWal } from './wal.js'

export const DEFAULT_PORT = 2980

export const DEFAULT_ADMIN_PORT = 2981

export const COLLECT_MAX_BYTES = 65_536

export const DEFAULT_MAX_REQUESTS = 1_024

const BUSY_RETRY_SECONDS = '5'

const ADMIN_MAX_BYTES = 4_194_304

const RESTORE_MAX_BYTES = 4_294_967_296

const QUERY_TIMEOUT_MS = 120_000

const MAX_QUEUED_QUERIES = 16

const BUILD_REFRESH_MS = 600_000

const WORKER_RESTART_MS = 5_000

const STOP_TIMEOUT_MS = 10_000

export const TLS_CHECK_MS = 3_600_000

const PREFLIGHT_HEADERS = {
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

const ADMIN_CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-disposition',
}

const ADMIN_PREFLIGHT_HEADERS = {
  ...ADMIN_CORS_HEADERS,
  'access-control-allow-methods': 'GET, POST, PUT, DELETE',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
}

const ADMIN_PATHS = ['/status', '/query', '/apps', '/backup', '/restore']

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const secure = (response, headers = {}) => {
  for (const [name, value] of Object.entries({ ...headers, ...SECURITY_HEADERS })) {
    response.headers.set(name, value)
  }
  return response
}

const versionResponse = () =>
  new Response(`imp-aly ${version}\n`, { headers: { 'content-type': 'text/plain' } })

const workerUrl = (name) => new URL(`./${name}`, import.meta.url).href

const readToken = (request) => {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : ''
}

const acquireLock = async (dataDir) => {
  const file = await Deno.open(join(dataDir, 'lock'), { write: true, create: true })
  if (!(await file.tryLock(true))) {
    file.close()
    throw new Error(`another imp-aly already uses the data folder ${dataDir}`)
  }
  return file
}

const bodyMismatch = () => new HttpError(401, 'unauthorized: the body does not match the token')

const saveUpload = async (request, dir, bodyHash) => {
  const tooLarge = () => new HttpError(413, `a backup is at most ${RESTORE_MAX_BYTES} bytes`)
  if (Number(request.headers.get('content-length')) > RESTORE_MAX_BYTES) throw tooLarge()
  if (!request.body) throw new HttpError(400, 'send the backup file as the body')
  await Deno.mkdir(dir, { recursive: true })
  const path = join(dir, `${crypto.randomUUID()}.tar.gz`)
  let total = 0
  const hash = createSha256()
  const limit = new TransformStream({
    transform: (chunk, controller) => {
      total += chunk.length
      hash.update(chunk)
      if (total > RESTORE_MAX_BYTES) controller.error(tooLarge())
      else controller.enqueue(chunk)
    },
  })
  try {
    const file = await Deno.open(path, { write: true, createNew: true })
    await request.body.pipeThrough(limit).pipeTo(file.writable)
  } catch (error) {
    await removeIfExists(path)
    throw error instanceof HttpError ? error : new HttpError(400, 'the body could not be read')
  }
  if (hash.digest() !== bodyHash) {
    await removeIfExists(path)
    throw bodyMismatch()
  }
  return path
}

const createQueryRunner = ({ dataDir, timeoutMs, log }) => {
  let worker = null
  let current = null
  let queued = 0
  let chain = Promise.resolve()

  const failCurrent = (error) => {
    const active = current
    current = null
    active?.reject(error)
  }

  const ensureWorker = () => {
    if (worker) return worker
    worker = new Worker(workerUrl('query-worker.js'), { type: 'module' })
    worker.onmessage = ({ data }) => {
      if (!current || current.id !== data.id) return
      const active = current
      current = null
      if (data.error !== undefined) {
        const error = data.status === 400 ? new QueryError(data.error) : new Error(data.error)
        active.reject(error)
      } else {
        active.resolve(data.result)
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      log.error(`The query worker failed: ${event.message}`)
      worker?.terminate()
      worker = null
      failCurrent(new Error('the query worker failed'))
    }
    return worker
  }

  let nextId = 0

  const execute = (query) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        worker?.terminate()
        worker = null
        failCurrent(new HttpError(504, `the query took longer than ${timeoutMs / 1000} s`))
      }, timeoutMs)
      current = {
        id,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      ensureWorker().postMessage({ id, dataDir, query })
    })

  return {
    run: (query) => {
      if (queued >= MAX_QUEUED_QUERIES) {
        return Promise.reject(new HttpError(503, 'too many queries wait - try again later'))
      }
      queued++
      const run = chain.then(() => execute(query)).finally(() => {
        queued--
      })
      chain = run.catch(() => {})
      return run
    },
    close: () => {
      worker?.terminate()
      worker = null
      failCurrent(new HttpError(503, 'the server stops'))
    },
  }
}

const createStorageRunner = (
  { dataDir, source, minFree, sealDelayMs, maintenanceMs, log, debug, quiet },
) => {
  let worker = null
  let status = null
  let stopping = false
  let restartTimer = null
  let onStopped = null
  let nextId = 0
  const restores = new Map()

  const failRestores = (error) => {
    for (const { reject } of restores.values()) reject(error)
    restores.clear()
  }

  const start = () => {
    worker = new Worker(workerUrl('storage-worker.js'), { type: 'module' })
    worker.onmessage = ({ data }) => {
      if (data.type === 'status') status = data.status
      if (data.type === 'stopped') onStopped?.()
      if (data.type === 'restored') {
        const restore = restores.get(data.id)
        restores.delete(data.id)
        if (data.error === undefined) restore?.resolve(data.result)
        else restore?.reject(new HttpError(data.status, data.error))
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      log.error(`The storage worker failed: ${event.message}`)
      worker?.terminate()
      worker = null
      failRestores(new HttpError(500, 'the storage worker failed'))
      onStopped?.()
      if (!stopping) restartTimer = setTimeout(start, WORKER_RESTART_MS)
    }
    worker.postMessage({
      type: 'init',
      dataDir,
      source,
      minFree,
      sealDelayMs,
      maintenanceMs,
      debug,
      quiet,
    })
  }

  start()

  return {
    wake: () => worker?.postMessage({ type: 'segment' }),
    status: () => status,
    restore: (path) =>
      new Promise((resolve, reject) => {
        if (!worker) {
          reject(new HttpError(503, 'the storage worker is not running - try again later'))
          return
        }
        const id = ++nextId
        restores.set(id, { resolve, reject })
        worker.postMessage({ type: 'restore', id, path })
      }),
    stop: async () => {
      stopping = true
      clearTimeout(restartTimer)
      if (!worker) return
      const stopped = new Promise((resolve) => {
        onStopped = resolve
        setTimeout(resolve, STOP_TIMEOUT_MS)
      })
      worker.postMessage({ type: 'stop' })
      await stopped
      worker?.terminate()
      worker = null
      failRestores(new HttpError(503, 'the server stops'))
    },
  }
}

const listen = (options, handler) => {
  if (options.hostname) return Deno.serve(options, handler)
  try {
    return Deno.serve({ ...options, hostname: '::' }, handler)
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) throw error
    return Deno.serve({ ...options, hostname: '0.0.0.0' }, handler)
  }
}

export const startServer = async ({
  port = DEFAULT_PORT,
  hostname,
  adminPort = DEFAULT_ADMIN_PORT,
  adminHostname,
  dataDir,
  key,
  ipHeader = null,
  trustedProxies = DEFAULT_TRUSTED_PROXIES,
  countryHeader = null,
  allowOrigins = null,
  limits = DEFAULT_LIMITS,
  maxClients,
  maxRequests = DEFAULT_MAX_REQUESTS,
  minFree = DEFAULT_MIN_FREE,
  tlsCert = null,
  tlsKey = null,
  tlsWatch = null,
  tlsCheckMs = TLS_CHECK_MS,
  onTlsChange = null,
  segmentMs,
  sealDelayMs,
  maintenanceMs,
  buildRefreshMs = BUILD_REFRESH_MS,
  queryTimeoutMs = QUERY_TIMEOUT_MS,
  fetchFile,
  log = logger,
  debug = false,
  quiet = false,
}) => {
  if (!key) throw new Error('the server needs a key')
  if (port !== 0 && port === adminPort) {
    throw new Error('the public port and the admin port must be different')
  }
  if (minFree) parseMinFree(minFree)
  const proxies = parseTrustedProxies(trustedProxies)
  const checkOrigin = createOriginCheck(allowOrigins)
  await Deno.mkdir(dataDir, { recursive: true })
  const lock = await acquireLock(dataDir)
  const uploadDir = join(dataDir, 'restore')
  const startedAt = new Date().toISOString()
  const cleanups = [() => lock.close()]
  const cleanup = async () => {
    for (const task of cleanups.reverse()) await task()
  }

  try {
    await checkDataFormat(dataDir)
    const source = await openSource(dataDir)
    await removeIfExists(uploadDir, { recursive: true })
    const apps = await openApps({ dataDir, ...(fetchFile ? { fetchFile } : {}) })
    let storage = null
    const wal = await openWal({
      dir: join(dataDir, 'wal'),
      ...(segmentMs ? { segmentMs } : {}),
      onSegment: () => storage?.wake(),
      log,
    })
    cleanups.push(() => wal.close())
    storage = createStorageRunner({
      dataDir,
      source,
      minFree,
      sealDelayMs,
      maintenanceMs,
      log,
      debug,
      quiet,
    })
    cleanups.push(() => storage.stop())
    const queries = createQueryRunner({ dataDir, timeoutMs: queryTimeoutMs, log })
    cleanups.push(() => queries.close())
    const limiter = createRateLimiter({ limits, ...(maxClients ? { maxClients } : {}) })
    const batchLimit = maxBatch(limits)
    let verifyToken = createTokenVerifier(key)
    const inFlight = { public: { count: 0 }, admin: { count: 0 } }

    let refreshing = false
    const refreshTimer = setInterval(async () => {
      if (refreshing) return
      refreshing = true
      try {
        await apps.refreshAll()
      } catch (error) {
        log.error(`The refresh of the build file failed: ${error.message}`)
      } finally {
        refreshing = false
      }
    }, buildRefreshMs)
    cleanups.push(() => clearInterval(refreshTimer))

    const collect = async (request, clients, name, headers) => {
      const app = isAppName(name) ? apps.get(name) : undefined
      if (!app) throw new HttpError(404, `no app "${name}" is registered`)
      const body = await readJsonBody(request, { maxBytes: COLLECT_MAX_BYTES })
      const inputs = Array.isArray(body) ? body : [body]
      if (inputs.length > batchLimit) {
        throw new HttpError(413, `a request holds at most ${batchLimit} records`)
      }
      const extra = Math.max(0, inputs.length - 1)
      const over = limiter.take(clients, extra)
      if (over) throw new HttpError(429, `too many records from this address in ${over.name}`)
      const country = countryHeader ? normalizeCountry(request.headers.get(countryHeader)) : null
      const now = Date.now()
      const lines = []
      let rejected = 0
      for (const input of inputs) {
        const { record, problem } = validateRecord(input, app, country, now)
        if (problem) {
          rejected++
          apps.countRejected(app, problem)
          log.debug(`Rejected a record of ${name}: ${problem}`)
        } else {
          lines.push(`${JSON.stringify([name, dayOf(record.at), record])}\n`)
        }
      }
      if (lines.length) {
        try {
          await wal.append(lines.join(''))
        } catch (error) {
          log.error(`The write-ahead log failed: ${error.message}`)
          throw new HttpError(503, 'the server cannot store records now')
        }
        apps.countAccepted(app, lines.length)
      }
      return json(202, { accepted: lines.length, rejected }, headers)
    }

    const admin = async (request, url) => {
      const path = url.pathname
      const method = request.method
      const { problem, bodyHash } = await verifyToken(readToken(request), {
        method,
        target: `${path}${url.search}`,
      })
      if (problem) throw new HttpError(401, `unauthorized: ${problem}`)
      const readBody = async () => {
        const bytes = await readBodyBytes(request, { maxBytes: ADMIN_MAX_BYTES })
        if (sha256Hex(bytes) !== bodyHash) throw bodyMismatch()
        return parseJsonBytes(bytes)
      }
      const noBody = () => {
        if (bodyHash !== EMPTY_BODY_HASH) throw bodyMismatch()
      }
      if (path === '/status' && method === 'GET') {
        noBody()
        return json(200, {
          version,
          dataFormat: DATA_FORMAT,
          startedAt,
          dataDir,
          source,
          apps: apps.list().length,
          rateLimitedClients: limiter.size(),
          activeRequests: { public: inFlight.public.count, admin: inFlight.admin.count },
          storage: storage.status(),
        })
      }
      if (path === '/query' && method === 'POST') {
        const query = parseQuery(await readBody())
        const answer = await queries.run(query)
        return json(200, { ...answer, appConfig: await appConfig(apps.get(query.app)) })
      }
      if (path === '/backup' && method === 'GET') {
        noBody()
        const options = parseBackupOptions(url.searchParams)
        return new Response(createBackupStream({ dataDir, ...options, sealDelayMs, log }), {
          headers: {
            'content-type': 'application/gzip',
            'content-disposition': 'attachment; filename="imp-aly-backup.tar.gz"',
          },
        })
      }
      if (path === '/restore' && method === 'POST') {
        const upload = await saveUpload(request, uploadDir, bodyHash)
        try {
          return json(200, await storage.restore(upload))
        } finally {
          await removeIfExists(upload)
        }
      }
      if (path === '/apps' && method === 'GET') {
        noBody()
        return json(200, { apps: apps.list() })
      }
      const appMatch = /^\/apps\/([^/]+)(\/refresh)?$/.exec(path)
      if (appMatch && !appMatch[2]) {
        const name = appMatch[1]
        if (method === 'GET') {
          noBody()
          return json(200, apps.describe(name))
        }
        if (method === 'PUT') return json(200, await apps.put(name, await readBody()))
        if (method === 'DELETE') {
          noBody()
          await apps.remove(name)
          return json(200, { removed: name })
        }
      }
      if (appMatch && appMatch[2] && method === 'POST') {
        noBody()
        return json(200, await apps.refresh(appMatch[1]))
      }
      throw new HttpError(404, `${method} ${path} is not an endpoint`)
    }

    const publicRoute = (request, url, clients, origin) => {
      const path = url.pathname
      const collectMatch = /^\/collect\/([^/]+)$/.exec(path)
      if (collectMatch) {
        if (!origin.allowed) throw new HttpError(403, 'this origin cannot send records')
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: { ...PREFLIGHT_HEADERS, ...origin.headers },
          })
        }
        if (request.method !== 'POST') throw new HttpError(405, 'send records with POST')
        return collect(request, clients, collectMatch[1], origin.headers)
      }
      if (path === '/' && request.method === 'GET') return versionResponse()
      throw new HttpError(404, `${request.method} ${path} is not an endpoint`)
    }

    const adminRoute = (request, url) => {
      const path = url.pathname
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: ADMIN_PREFLIGHT_HEADERS })
      }
      if (path === '/' && request.method === 'GET') return versionResponse()
      if (ADMIN_PATHS.includes(path) || path.startsWith('/apps/')) return admin(request, url)
      throw new HttpError(404, `${request.method} ${path} is not an endpoint`)
    }

    const createHandler = (route, counter) => async (request, info) => {
      const url = new URL(request.url)
      const origin = route === publicRoute && url.pathname.startsWith('/collect/')
        ? checkOrigin(request.headers.get('origin'))
        : { allowed: true, headers: route === adminRoute ? ADMIN_CORS_HEADERS : {} }
      const { headers } = origin
      if (counter.count >= maxRequests) {
        await request.body?.cancel().catch(() => {})
        return secure(json(
          503,
          { error: 'the server is busy, try again later' },
          { ...headers, 'retry-after': BUSY_RETRY_SECONDS },
        ))
      }
      const clients = clientKeys(
        clientAddress(request, info, { ipHeader, trustedProxies: proxies }),
      )
      const exceeded = limiter.take(clients, 1)
      if (exceeded) {
        await request.body?.cancel().catch(() => {})
        return secure(json(
          429,
          { error: `too many requests from this address in ${exceeded.name}` },
          headers,
        ))
      }
      counter.count++
      try {
        return secure(await route(request, url, clients, origin), headers)
      } catch (error) {
        if (
          error instanceof HttpError || error instanceof AppError ||
          error instanceof QueryError || error instanceof BackupError
        ) {
          return secure(json(error.status, { error: error.message }, headers))
        }
        log.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        return secure(json(500, { error: 'internal error' }, headers))
      } finally {
        counter.count--
      }
    }

    const handlers = [
      { port, hostname, handler: createHandler(publicRoute, inFlight.public) },
      {
        port: adminPort,
        hostname: adminHostname ?? hostname,
        handler: createHandler(adminRoute, inFlight.admin),
      },
    ]

    const readTls = () =>
      tlsCert && tlsKey
        ? { cert: Deno.readTextFileSync(tlsCert), key: Deno.readTextFileSync(tlsKey) }
        : {}
    let tls = readTls()
    let servers = []
    cleanups.push(async () => {
      for (const server of servers) await server.shutdown()
    })
    for (const { port, hostname, handler } of handlers) {
      servers.push(listen({ port, hostname, onListen: () => {}, ...tls }, handler))
    }
    const addresses = servers.map((server) => ({
      port: server.addr.port,
      hostname: server.addr.hostname,
    }))

    const serveAll = (options) => {
      const started = []
      try {
        for (const [index, { handler }] of handlers.entries()) {
          started.push(Deno.serve({ ...addresses[index], onListen: () => {}, ...options }, handler))
        }
        return started
      } catch (error) {
        for (const server of started) server.shutdown()
        throw error
      }
    }

    const reloadTls = async () => {
      let fresh
      try {
        fresh = readTls()
      } catch (error) {
        log.error(`Cannot read the new TLS certificate: ${error.message}`)
        return false
      }
      log.info('The TLS certificate changed, the server restarts its listeners')
      for (const server of servers) await server.shutdown()
      try {
        servers = serveAll(fresh)
        tls = fresh
        return true
      } catch (error) {
        log.error(
          `The new TLS certificate does not work, the server keeps the old one: ${error.message}`,
        )
        servers = serveAll(tls)
        return false
      }
    }
    if (tlsCert && tlsKey) {
      const watcher = await watchFiles({
        paths: tlsWatch ?? [tlsCert, tlsKey],
        intervalMs: tlsCheckMs,
        onChange: onTlsChange ?? reloadTls,
        log,
      })
      cleanups.push(() => watcher.stop())
    }

    let stopped = null
    return {
      port: addresses[0].port,
      hostname: addresses[0].hostname,
      adminPort: addresses[1].port,
      adminHostname: addresses[1].hostname,
      setKey: (next) => {
        if (!next) throw new Error('the server needs a key')
        verifyToken = createTokenVerifier(next)
      },
      shutdown: () => {
        stopped ??= (async () => {
          await cleanup()
          await apps.flush().catch(() => {})
        })()
        return stopped
      },
    }
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}
