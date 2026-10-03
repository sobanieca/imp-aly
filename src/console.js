import { serversPath } from './servers.js'
import { uiIsBuilt } from './static-files.js'

export const DEFAULT_CONSOLE_PORT = 8010

export const defaultUiDir = () =>
  decodeURIComponent(new URL('../console/dist', import.meta.url).pathname)

const listen = (options, handler) => Deno.serve({ ...options, onListen: () => {} }, handler)

export const startConsole = async (
  { port = DEFAULT_CONSOLE_PORT, uiDir = defaultUiDir(), serversFile = serversPath() } = {},
) => {
  if (!(await uiIsBuilt(uiDir))) {
    throw new Error(`the console page is missing in ${uiDir} - run: deno task console:build`)
  }
  const { consoleHosts, createConsoleApp } = await import('./console-api.js')
  let hosts = consoleHosts(port)
  const app = createConsoleApp({ uiDir, serversFile, hosts: () => hosts })
  let main
  try {
    main = listen({ hostname: '127.0.0.1', port }, app.fetch)
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
    servers.push(listen({ hostname: '::1', port: bound }, app.fetch))
  } catch {
    servers.length = 1
  }
  return {
    port: bound,
    url: `http://localhost:${bound}`,
    shutdown: () => Promise.all(servers.map((server) => server.shutdown())),
  }
}
