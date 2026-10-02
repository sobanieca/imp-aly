import { parsePort, parsePositiveInteger, requireOnlyFlags } from '../args.js'
import { findKey, findOrCreateKey } from '../auth.js'
import { logger } from '../logger.js'
import { formatHost, getLocalAddresses } from '../net.js'
import { parseOrigins } from '../origins.js'
import { absolutePath } from '../paths.js'
import { DEFAULT_LIMITS, DEFAULT_TRUSTED_PROXIES, parseTrustedProxies } from '../rate-limit.js'
import { DEFAULT_MIN_FREE, parseMinFree } from '../retention.js'
import { DEFAULT_ADMIN_PORT, DEFAULT_MAX_REQUESTS, DEFAULT_PORT, startServer } from '../server.js'
import {
  credentialPath,
  CREDENTIALS,
  ensureService,
  isInsideService,
  SERVICE_DATA_DIR,
  SERVICE_NAME,
  serviceBlocker,
  uninstallService,
} from '../service.js'
import { version } from '../version.js'

export const DEFAULT_DATA_DIR = '~/.imp-aly'

const SERVE_FLAGS = [
  'port',
  'adminPort',
  'data',
  'auth',
  'bind',
  'adminBind',
  'ipHeader',
  'trustedProxy',
  'maxRequests',
  'countryHeader',
  'allowOrigin',
  'minFree',
  'tlsCert',
  'tlsKey',
  'limit5s',
  'limit1m',
  'limit1h',
  'limit24h',
  'foreground',
  'uninstall',
]

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/

const readHeaderName = (value, flag) => {
  if (value === undefined) return null
  if (!HEADER_NAME.test(value)) throw new Error(`${flag} "${value}" is not a header name`)
  return value.toLowerCase()
}

const readTrustedProxies = (value) => {
  if (value === undefined) return DEFAULT_TRUSTED_PROXIES
  const list = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (!list.length) throw new Error('--trusted-proxy needs at least one address or network')
  try {
    parseTrustedProxies(list)
  } catch (error) {
    throw new Error(`--trusted-proxy: ${error.message}`)
  }
  return list
}

const readAllowOrigins = (value) => {
  if (value === undefined) return null
  const list = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (!list.length) throw new Error('--allow-origin needs at least one origin')
  try {
    return parseOrigins(list)
  } catch (error) {
    throw new Error(`--allow-origin: ${error.message}`)
  }
}

const sameList = (a, b) => a.length === b.length && a.every((entry, index) => entry === b[index])

export const readServeOptions = (flags) => {
  const minFree = flags.minFree ?? DEFAULT_MIN_FREE
  parseMinFree(minFree)
  if (Boolean(flags.tlsCert) !== Boolean(flags.tlsKey)) {
    throw new Error('--tls-cert and --tls-key go together')
  }
  if (flags.trustedProxy !== undefined && flags.ipHeader === undefined) {
    throw new Error('--trusted-proxy works only with --ip-header')
  }
  const port = flags.port === undefined ? DEFAULT_PORT : parsePort(flags.port)
  const adminPort = flags.adminPort === undefined ? DEFAULT_ADMIN_PORT : parsePort(flags.adminPort)
  if (port === adminPort) {
    throw new Error(`--port and --admin-port must be different (both are ${port})`)
  }
  return {
    port,
    adminPort,
    dataDir: flags.data === undefined ? null : absolutePath(flags.data),
    bind: flags.bind ?? null,
    adminBind: flags.adminBind ?? null,
    ipHeader: readHeaderName(flags.ipHeader, '--ip-header'),
    trustedProxies: readTrustedProxies(flags.trustedProxy),
    maxRequests: flags.maxRequests === undefined
      ? DEFAULT_MAX_REQUESTS
      : parsePositiveInteger(flags.maxRequests, '--max-requests'),
    countryHeader: readHeaderName(flags.countryHeader, '--country-header'),
    allowOrigins: readAllowOrigins(flags.allowOrigin),
    minFree,
    tlsCert: flags.tlsCert ? absolutePath(flags.tlsCert) : null,
    tlsKey: flags.tlsKey ? absolutePath(flags.tlsKey) : null,
    limits: DEFAULT_LIMITS.map((window) => {
      const value = flags[`limit${window.name}`]
      return value === undefined
        ? { ...window }
        : { ...window, limit: parsePositiveInteger(value, `--limit-${window.name}`) }
    }),
  }
}

export const serviceArgs = (options) => {
  const args = [
    'server',
    '--port',
    String(options.port),
    '--admin-port',
    String(options.adminPort),
    '--data',
    options.dataDir,
  ]
  if (options.bind) args.push('--bind', options.bind)
  if (options.adminBind) args.push('--admin-bind', options.adminBind)
  if (options.ipHeader) args.push('--ip-header', options.ipHeader)
  if (options.ipHeader && !sameList(options.trustedProxies, DEFAULT_TRUSTED_PROXIES)) {
    args.push('--trusted-proxy', options.trustedProxies.join(','))
  }
  if (options.maxRequests !== DEFAULT_MAX_REQUESTS) {
    args.push('--max-requests', String(options.maxRequests))
  }
  if (options.countryHeader) args.push('--country-header', options.countryHeader)
  if (options.allowOrigins) args.push('--allow-origin', options.allowOrigins.join(','))
  if (options.minFree !== DEFAULT_MIN_FREE) args.push('--min-free', options.minFree)
  if (options.tlsCert) args.push('--tls-cert', options.tlsCert, '--tls-key', options.tlsKey)
  DEFAULT_LIMITS.forEach((window, index) => {
    const limit = options.limits[index].limit
    if (limit !== window.limit) args.push(`--limit-${window.name}`, String(limit))
  })
  return args
}

const printBanner = ({ options, key, keyPath, mode }) => {
  const scheme = options.tlsCert ? 'https' : 'http'
  const addresses = options.bind ? [options.bind] : getLocalAddresses()
  const best = addresses[0] ?? '127.0.0.1'
  const others = addresses.slice(1)
  const origin = `${scheme}://${formatHost(best)}:${options.port}`
  const adminOrigin = `${scheme}://${formatHost(options.adminBind ?? best)}:${options.adminPort}`
  const modeLine = {
    running: `systemd service "${SERVICE_NAME}" is running`,
    started: `systemd service "${SERVICE_NAME}" started`,
    installed: `systemd service "${SERVICE_NAME}" installed and started`,
    updated: `systemd service "${SERVICE_NAME}" updated and restarted`,
    foreground: 'running in the foreground (no systemd service)',
  }[mode]
  const serviceLines = mode === 'foreground' ? '' : `
Logs: journalctl -u ${SERVICE_NAME} -f    Remove: sudo imp-aly server --uninstall
`
  logger.plain(`
imp-aly ${version} - ${modeLine}

  Address:   ${origin}${others.length ? `\n  Other IPs: ${others.join(', ')}` : ''}
  Collect:   ${origin}/collect/<app>
  Admin:     ${adminOrigin}  (the app, query, backup and status commands)
  Key:       ${key}
  Key file:  ${keyPath}
  Data:      ${options.dataDir}

Run this command again anytime to see the address and the key.
When the VPS has a public IP that is not listed, use that IP.
Open the port ${options.port} to the internet.
Open the port ${options.adminPort} only to the machines that run the client commands.

Register an app (on this machine, or anywhere with --url <admin address> and -a):

  imp-aly app add myapp https://myapp.example/app-map.txt
${serviceLines}`)
}

const run = async ({ options, key, keyPath, debug, service = false }) => {
  let stop = null
  const server = await startServer({
    port: options.port,
    hostname: options.bind ?? undefined,
    adminPort: options.adminPort,
    adminHostname: options.adminBind ?? undefined,
    dataDir: options.dataDir,
    key,
    ipHeader: options.ipHeader,
    trustedProxies: options.trustedProxies,
    maxRequests: options.maxRequests,
    countryHeader: options.countryHeader,
    allowOrigins: options.allowOrigins,
    limits: options.limits,
    minFree: options.minFree,
    ...(service && options.tlsCert
      ? {
        tlsCert: credentialPath(CREDENTIALS.tlsCert),
        tlsKey: credentialPath(CREDENTIALS.tlsKey),
        tlsWatch: [options.tlsCert, options.tlsKey],
        onTlsChange: () => {
          logger.info('The TLS certificate changed, the service restarts to load it')
          setTimeout(() => stop(), 0)
          return true
        },
      }
      : { tlsCert: options.tlsCert, tlsKey: options.tlsKey }),
    debug,
  })
  if (service) {
    logger.info(
      `imp-aly ${version} listens on port ${server.port}, and on port ${server.adminPort} for admin`,
    )
  } else {
    printBanner({ options, key, keyPath, mode: 'foreground' })
  }
  let stopping = false
  stop = async () => {
    if (stopping) return
    stopping = true
    logger.info('Shutting down...')
    await server.shutdown()
    Deno.exit(0)
  }
  Deno.addSignalListener('SIGINT', stop)
  Deno.addSignalListener('SIGTERM', stop)
  await new Promise(() => {})
}

export const server = async ({ positional, flags }) => {
  requireOnlyFlags(flags, SERVE_FLAGS, 'server')
  if (positional.length > 1) {
    throw new Error(`server takes no argument "${positional[1]}" - run imp-aly help`)
  }
  if (flags.uninstall) return await uninstallService()
  const options = readServeOptions(flags)
  const debug = Boolean(flags.debug)
  if (isInsideService()) {
    const key = findKey(credentialPath(CREDENTIALS.key))
    const inService = { ...options, dataDir: options.dataDir ?? SERVICE_DATA_DIR }
    return await run({ options: inService, key, keyPath: null, debug, service: true })
  }
  const { key, path: keyPath } = findOrCreateKey(flags.auth)
  const blocker = flags.foreground ? null : serviceBlocker()
  if (flags.foreground || blocker) {
    if (blocker) {
      logger.warn(
        `Cannot install the systemd service (${blocker}). The server runs in the foreground and does not start again after a reboot.`,
      )
    }
    const foreground = { ...options, dataDir: options.dataDir ?? absolutePath(DEFAULT_DATA_DIR) }
    return await run({ options: foreground, key, keyPath, debug })
  }
  const serviceOptions = { ...options, dataDir: options.dataDir ?? SERVICE_DATA_DIR }
  const mode = await ensureService({
    args: serviceArgs(serviceOptions),
    dataDir: serviceOptions.dataDir,
    ports: [serviceOptions.port, serviceOptions.adminPort],
    keyPath,
    tlsCert: serviceOptions.tlsCert,
    tlsKey: serviceOptions.tlsKey,
  })
  printBanner({ options: serviceOptions, key, keyPath, mode })
}
