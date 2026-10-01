import { AppError, openApps } from './apps.js'
import { createTokenVerifier } from './auth.js'
import { dayOf } from './days.js'
import { HttpError, readJsonBody } from './http-body.js'
import { logger } from './logger.js'
import { isAppName } from './names.js'
import { join } from './paths.js'
import { parseQuery, QueryError } from './query.js'
import { clientAddress, clientKey, createRateLimiter, DEFAULT_LIMITS } from './rate-limit.js'
import { MAX_RECORDS_PER_REQUEST, normalizeCountry, validateRecord } from './records.js'
import { DEFAULT_MIN_FREE, parseMinFree } from './retention.js'
import { version } from './version.js'
import { openWal } from './wal.js'

export const DEFAULT_PORT = 2980

export const COLLECT_MAX_BYTES = 65_536

const ADMIN_MAX_BYTES = 2_097_152

const QUERY_TIMEOUT_MS = 120_000

const MAX_QUEUED_QUERIES = 16

const MAP_REFRESH_MS = 600_000

const WORKER_RESTART_MS = 5_000

const STOP_TIMEOUT_MS = 10_000

const CORS_HEADERS = { 'access-control-allow-origin': '*' }

const PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

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
    throw new Error(`another imp-analytics-server already uses the data folder ${dataDir}`)
  }
  return file
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
  { dataDir, minFree, sealDelayMs, maintenanceMs, log, debug, quiet },
) => {
  let worker = null
  let status = null
  let stopping = false
  let restartTimer = null
  let onStopped = null

  const start = () => {
    worker = new Worker(workerUrl('storage-worker.js'), { type: 'module' })
    worker.onmessage = ({ data }) => {
      if (data.type === 'status') status = data.status
      if (data.type === 'stopped') onStopped?.()
    }
    worker.onerror = (event) => {
      event.preventDefault()
      log.error(`The storage worker failed: ${event.message}`)
      worker?.terminate()
      worker = null
      onStopped?.()
      if (!stopping) restartTimer = setTimeout(start, WORKER_RESTART_MS)
    }
    worker.postMessage({
      type: 'init',
      dataDir,
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
  dataDir,
  key,
  ipHeader = null,
  countryHeader = null,
  limits = DEFAULT_LIMITS,
  maxClients,
  minFree = DEFAULT_MIN_FREE,
  tlsCert = null,
  tlsKey = null,
  segmentMs,
  sealDelayMs,
  maintenanceMs,
  mapRefreshMs = MAP_REFRESH_MS,
  queryTimeoutMs = QUERY_TIMEOUT_MS,
  fetchMap,
  log = logger,
  debug = false,
  quiet = false,
}) => {
  if (!key) throw new Error('the server needs a key')
  if (minFree) parseMinFree(minFree)
  await Deno.mkdir(dataDir, { recursive: true })
  const lock = await acquireLock(dataDir)
  const startedAt = new Date().toISOString()
  const cleanups = [() => lock.close()]
  const cleanup = async () => {
    for (const task of cleanups.reverse()) await task()
  }

  try {
    const apps = await openApps({ dataDir, ...(fetchMap ? { fetchMap } : {}) })
    let storage = null
    const wal = await openWal({
      dir: join(dataDir, 'wal'),
      ...(segmentMs ? { segmentMs } : {}),
      onSegment: () => storage?.wake(),
    })
    cleanups.push(() => wal.close())
    storage = createStorageRunner({
      dataDir,
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
    const verifyToken = createTokenVerifier(key)

    let refreshing = false
    const refreshTimer = setInterval(async () => {
      if (refreshing) return
      refreshing = true
      try {
        await apps.refreshAll()
      } catch (error) {
        log.error(`App map refresh failed: ${error.message}`)
      } finally {
        refreshing = false
      }
    }, mapRefreshMs)
    cleanups.push(() => clearInterval(refreshTimer))

    const collect = async (request, ip, name) => {
      const app = isAppName(name) ? apps.get(name) : undefined
      if (!app) throw new HttpError(404, `no app "${name}" is registered`)
      const body = await readJsonBody(request, { maxBytes: COLLECT_MAX_BYTES })
      const inputs = Array.isArray(body) ? body : [body]
      if (inputs.length > MAX_RECORDS_PER_REQUEST) {
        throw new HttpError(413, `a request holds at most ${MAX_RECORDS_PER_REQUEST} records`)
      }
      limiter.add(ip, Math.max(0, inputs.length - 1))
      const over = limiter.over(ip)
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
      return json(202, { accepted: lines.length, rejected }, CORS_HEADERS)
    }

    const admin = async (request, path) => {
      const problem = await verifyToken(readToken(request))
      if (problem) throw new HttpError(401, `unauthorized: ${problem}`)
      const method = request.method
      if (path === '/status' && method === 'GET') {
        return json(200, {
          version,
          startedAt,
          dataDir,
          apps: apps.list().length,
          rateLimitedClients: limiter.size(),
          storage: storage.status(),
        })
      }
      if (path === '/query' && method === 'POST') {
        const query = parseQuery(await readJsonBody(request, { maxBytes: ADMIN_MAX_BYTES }))
        return json(200, await queries.run(query))
      }
      if (path === '/apps' && method === 'GET') return json(200, { apps: apps.list() })
      const appMatch = /^\/apps\/([^/]+)(\/refresh)?$/.exec(path)
      if (appMatch && !appMatch[2]) {
        const name = appMatch[1]
        if (method === 'GET') return json(200, apps.describe(name))
        if (method === 'PUT') {
          const body = await readJsonBody(request, { maxBytes: ADMIN_MAX_BYTES })
          return json(200, await apps.put(name, body))
        }
        if (method === 'DELETE') {
          await apps.remove(name)
          return json(200, { removed: name })
        }
      }
      if (appMatch && appMatch[2] && method === 'POST') {
        return json(200, await apps.refresh(appMatch[1]))
      }
      throw new HttpError(404, `${method} ${path} is not an endpoint`)
    }

    const route = (request, ip) => {
      const path = new URL(request.url).pathname
      const collectMatch = /^\/collect\/([^/]+)$/.exec(path)
      if (collectMatch) {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS })
        }
        if (request.method !== 'POST') throw new HttpError(405, 'send records with POST')
        return collect(request, ip, collectMatch[1])
      }
      if (path === '/' && request.method === 'GET') {
        return new Response(`imp-analytics-server ${version}\n`, {
          headers: { 'content-type': 'text/plain' },
        })
      }
      if (
        path === '/status' || path === '/query' || path === '/apps' || path.startsWith('/apps/')
      ) {
        return admin(request, path)
      }
      throw new HttpError(404, `${request.method} ${path} is not an endpoint`)
    }

    const handler = async (request, info) => {
      const isCollect = new URL(request.url).pathname.startsWith('/collect/')
      const headers = isCollect ? CORS_HEADERS : {}
      const ip = clientKey(clientAddress(request, info, ipHeader))
      const exceeded = limiter.exceeded(ip)
      if (exceeded) {
        return json(
          429,
          { error: `too many requests from this address in ${exceeded.name}` },
          headers,
        )
      }
      limiter.add(ip, 1)
      try {
        return await route(request, ip)
      } catch (error) {
        if (
          error instanceof HttpError || error instanceof AppError || error instanceof QueryError
        ) {
          return json(error.status, { error: error.message }, headers)
        }
        log.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        return json(500, { error: 'internal error' }, headers)
      }
    }

    const server = listen(
      {
        port,
        hostname,
        onListen: () => {},
        ...(tlsCert && tlsKey
          ? { cert: Deno.readTextFileSync(tlsCert), key: Deno.readTextFileSync(tlsKey) }
          : {}),
      },
      handler,
    )
    cleanups.push(() => server.shutdown())

    let stopped = null
    return {
      port: server.addr.port,
      hostname: server.addr.hostname,
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
