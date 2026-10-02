import { resolveKey } from './auth.js'
import { dirname, getHome, join } from './paths.js'

export const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

export const serversPath = () => {
  const base = Deno.env.get('XDG_CONFIG_HOME') || join(getHome(), '.config')
  return join(base, 'imp-aly', 'servers.json')
}

const readStore = (path) => {
  let text
  try {
    text = Deno.readTextFileSync(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { default: '', servers: [] }
    throw error
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${path} is not valid JSON - fix it or delete it`)
  }
  return {
    default: typeof data?.default === 'string' ? data.default : '',
    servers: Array.isArray(data?.servers) ? data.servers : [],
  }
}

const writeStore = (path, store) => {
  Deno.mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  Deno.writeTextFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  Deno.renameSync(temporary, path)
}

export const loadServers = (path = serversPath()) => readStore(path)

export const parseServerUrl = (value) => {
  let url
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    url = null
  }
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`"${value}" is not a server URL - use http(s)://host[:port]`)
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`"${value}" must not have a query, a fragment or a user`)
  }
  return url.href.replace(/\/+$/, '')
}

const storedAuth = (auth) => {
  if (auth === undefined || String(auth).trim() === '') return undefined
  const { path, key } = resolveKey(auth)
  return path || key
}

export const addServer = ({ name, url, auth }, path = serversPath()) => {
  if (!SERVER_NAME_PATTERN.test(String(name ?? ''))) {
    throw new Error(
      `"${name}" is not a server name - use letters, digits, ".", "_" and "-", up to 63`,
    )
  }
  const server = { name, url: parseServerUrl(url) }
  const savedAuth = storedAuth(auth)
  if (savedAuth) server.auth = savedAuth
  const store = readStore(path)
  const index = store.servers.findIndex((entry) => entry.name === name)
  if (index === -1) store.servers.push(server)
  else store.servers[index] = server
  store.default = name
  writeStore(path, store)
  return server
}

export const removeServer = (name, path = serversPath()) => {
  const store = readStore(path)
  const found = store.servers.find((entry) => entry.name === name)
  if (!found) throw new Error(`no server named "${name}" - see imp-aly ls`)
  store.servers = store.servers.filter((entry) => entry.name !== name)
  if (store.default === name) store.default = store.servers.at(-1)?.name ?? ''
  writeStore(path, store)
  return found
}

export const useServer = (name, path = serversPath()) => {
  const store = readStore(path)
  const found = store.servers.find((entry) => entry.name === name)
  if (!found) throw new Error(`no server named "${name}" - see imp-aly ls`)
  store.default = name
  writeStore(path, store)
  return found
}

export const findServer = (name, path = serversPath()) => {
  const found = readStore(path).servers.find((entry) => entry.name === name)
  if (!found) throw new Error(`no server named "${name}" - see imp-aly ls`)
  return found
}

export const defaultServer = (path = serversPath()) => {
  const store = readStore(path)
  return store.servers.find((entry) => entry.name === store.default) ?? null
}

export const serverNames = (value) => {
  const names = String(value).split(',').map((name) => name.trim())
  if (names.some((name) => name === '')) {
    throw new Error(`"${value}" is not a list of server names - use a,b,c`)
  }
  if (new Set(names).size !== names.length) throw new Error(`"${value}" names a server twice`)
  return names
}

export const resolveTarget = ({ url, auth, server }, path = serversPath()) => {
  if (url !== undefined && server !== undefined) {
    throw new Error('give --server or --url, not both')
  }
  if (server !== undefined && serverNames(server).length > 1) {
    throw new Error(`this command takes one server, not "${server}"`)
  }
  if (url !== undefined) return { url: parseServerUrl(url), auth, server: null }
  const saved = server === undefined ? defaultServer(path) : findServer(server, path)
  if (!saved) return { url: undefined, auth, server: null }
  return { url: saved.url, auth: auth ?? saved.auth, server: saved.name }
}
