import { parsePort, parsePositiveInteger, requireOnlyFlags } from '../args.js'
import { findOrCreateKey } from '../auth.js'
import { logger } from '../logger.js'
import { formatHost, getLocalAddresses } from '../net.js'
import { absolutePath, getHome } from '../paths.js'
import { DEFAULT_LIMITS } from '../rate-limit.js'
import { DEFAULT_MIN_FREE, parseMinFree } from '../retention.js'
import { DEFAULT_PORT, startServer } from '../server.js'
import {
  ensureService,
  isInsideService,
  SERVICE_NAME,
  serviceBlocker,
  uninstallService,
} from '../service.js'
import { version } from '../version.js'

export const DEFAULT_DATA_DIR = '~/.imp-analytics-server'

const SERVE_FLAGS = [
  'port',
  'data',
  'auth',
  'bind',
  'ipHeader',
  'countryHeader',
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

export const readServeOptions = (flags) => {
  const minFree = flags.minFree ?? DEFAULT_MIN_FREE
  parseMinFree(minFree)
  if (Boolean(flags.tlsCert) !== Boolean(flags.tlsKey)) {
    throw new Error('--tls-cert and --tls-key go together')
  }
  return {
    port: flags.port === undefined ? DEFAULT_PORT : parsePort(flags.port),
    dataDir: absolutePath(flags.data ?? DEFAULT_DATA_DIR),
    bind: flags.bind ?? null,
    ipHeader: readHeaderName(flags.ipHeader, '--ip-header'),
    countryHeader: readHeaderName(flags.countryHeader, '--country-header'),
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

export const serviceArgs = (options, keyPath) => {
  const args = ['--port', String(options.port), '--data', options.dataDir, '--auth', keyPath]
  if (options.bind) args.push('--bind', options.bind)
  if (options.ipHeader) args.push('--ip-header', options.ipHeader)
  if (options.countryHeader) args.push('--country-header', options.countryHeader)
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
  const modeLine = {
    running: `systemd service "${SERVICE_NAME}" is running`,
    started: `systemd service "${SERVICE_NAME}" started`,
    installed: `systemd service "${SERVICE_NAME}" installed and started`,
    updated: `systemd service "${SERVICE_NAME}" updated and restarted`,
    foreground: 'running in the foreground (no systemd service)',
  }[mode]
  const serviceLines = mode === 'foreground' ? '' : `
Logs: journalctl -u ${SERVICE_NAME} -f    Remove: sudo imp-analytics-server --uninstall
`
  logger.plain(`
imp-analytics-server ${version} - ${modeLine}

  Address:   ${origin}${others.length ? `\n  Other IPs: ${others.join(', ')}` : ''}
  Collect:   ${origin}/collect/<app>
  Key:       ${key}
  Key file:  ${keyPath}
  Data:      ${options.dataDir}

Run this command again anytime to see the address and the key.
When the VPS has a public IP that is not listed, use that IP.

Register an app (on this machine, or anywhere with --url and -a):

  imp-analytics-server app add myapp https://myapp.example/app-map.txt
${serviceLines}`)
}

const runForeground = async ({ options, key, keyPath, debug }) => {
  const server = await startServer({
    port: options.port,
    hostname: options.bind ?? undefined,
    dataDir: options.dataDir,
    key,
    ipHeader: options.ipHeader,
    countryHeader: options.countryHeader,
    limits: options.limits,
    minFree: options.minFree,
    tlsCert: options.tlsCert,
    tlsKey: options.tlsKey,
    debug,
  })
  if (isInsideService()) {
    logger.info(`imp-analytics-server ${version} listens on port ${server.port}`)
  } else {
    printBanner({ options, key, keyPath, mode: 'foreground' })
  }
  let stopping = false
  const stop = async () => {
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

export const serve = async ({ positional, flags }) => {
  requireOnlyFlags(flags, SERVE_FLAGS, 'imp-analytics-server')
  if (positional.length) {
    throw new Error(`unknown command "${positional[0]}" - run imp-analytics-server help`)
  }
  if (flags.uninstall) return await uninstallService()
  const options = readServeOptions(flags)
  const { key, path: keyPath } = findOrCreateKey(flags.auth)
  if (isInsideService() || flags.foreground) {
    return await runForeground({ options, key, keyPath, debug: Boolean(flags.debug) })
  }
  const blocker = serviceBlocker()
  if (blocker) {
    logger.warn(
      `Cannot install the systemd service (${blocker}). The server runs in the foreground and does not start again after a reboot.`,
    )
    return await runForeground({ options, key, keyPath, debug: Boolean(flags.debug) })
  }
  const mode = await ensureService({ args: serviceArgs(options, keyPath), home: getHome() })
  printBanner({ options, key, keyPath, mode })
}
