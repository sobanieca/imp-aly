import { serveUi, uiIsBuilt } from './static-files.js'

export const DEFAULT_CONSOLE_PORT = 8010

const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self' https: http:",
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

const READ_METHODS = ['GET', 'HEAD']

export const defaultUiDir = () =>
  decodeURIComponent(new URL('../console/dist', import.meta.url).pathname)

export const consoleHosts = (port) =>
  new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])

const plain = (status, text) =>
  new Response(`${text}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

export const createConsoleHandler = ({ uiDir, hosts }) => async (request) => {
  let response
  if (!hosts().has(request.headers.get('host') ?? '')) {
    response = plain(403, 'the console answers only on localhost')
  } else if (!READ_METHODS.includes(request.method)) {
    response = plain(405, 'the console serves files only')
  } else {
    response = await serveUi(uiDir, new URL(request.url).pathname)
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value)
  return response
}

const listen = (options, handler) => Deno.serve({ ...options, onListen: () => {} }, handler)

export const startConsole = async (
  { port = DEFAULT_CONSOLE_PORT, uiDir = defaultUiDir() } = {},
) => {
  if (!(await uiIsBuilt(uiDir))) {
    throw new Error(`the console page is missing in ${uiDir} - run: deno task console:build`)
  }
  let hosts = consoleHosts(port)
  const handler = createConsoleHandler({ uiDir, hosts: () => hosts })
  let main
  try {
    main = listen({ hostname: '127.0.0.1', port }, handler)
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      throw new Error(`the port ${port} is in use - choose another one with --port`)
    }
    throw error
  }
  const bound = main.addr.port
  hosts = consoleHosts(bound)
  const servers = [main]
  try {
    servers.push(listen({ hostname: '::1', port: bound }, handler))
  } catch {
    servers.length = 1
  }
  return {
    port: bound,
    url: `http://localhost:${bound}`,
    shutdown: () => Promise.all(servers.map((server) => server.shutdown())),
  }
}
