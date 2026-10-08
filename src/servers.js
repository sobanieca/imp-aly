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
    if (error instanceof Deno.errors.NotFound) return { default: '', servers: [], groups: [] }
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
    groups: Array.isArray(data?.groups) ? data.groups : [],
  }
}

const writeStore = (path, store) => {
  Deno.mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  Deno.writeTextFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  Deno.renameSync(temporary, path)
}

export const loadServers = (path = serversPath()) => readStore(path)

export const keyLabel = (auth) => {
  if (!auth) return 'default key file'
  return auth.startsWith('/') ? auth : 'saved key'
}

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

const checkName = (name, kind) => {
  if (!SERVER_NAME_PATTERN.test(String(name ?? ''))) {
    throw new Error(
      `"${name}" is not a ${kind} name - use letters, digits, ".", "_" and "-", up to 63`,
    )
  }
}

const findEntry = (store, name) => {
  const server = store.servers.find((entry) => entry.name === name)
  if (server) return { server }
  const group = store.groups.find((entry) => entry.name === name)
  if (group) return { group }
  throw new Error(`no server or group named "${name}" - see imp-aly ls`)
}

export const addServer = ({ name, url, auth }, path = serversPath()) => {
  checkName(name, 'server')
  const server = { name, url: parseServerUrl(url) }
  const savedAuth = storedAuth(auth)
  if (savedAuth) server.auth = savedAuth
  const store = readStore(path)
  if (store.groups.some((entry) => entry.name === name)) {
    throw new Error(`"${name}" is a group - use another name, or remove the group first`)
  }
  const index = store.servers.findIndex((entry) => entry.name === name)
  if (index === -1) store.servers.push(server)
  else store.servers[index] = server
  store.default = name
  writeStore(path, store)
  return server
}

export const serverNames = (value) => {
  const names = String(value).split(',').map((name) => name.trim())
  if (names.some((name) => name === '')) {
    throw new Error(`"${value}" is not a list of server names - use a,b,c`)
  }
  if (new Set(names).size !== names.length) throw new Error(`"${value}" names a server twice`)
  return names
}

export const addGroup = ({ name, servers }, path = serversPath()) => {
  checkName(name, 'group')
  const members = serverNames(servers ?? '')
  const store = readStore(path)
  if (store.servers.some((entry) => entry.name === name)) {
    throw new Error(`"${name}" is a saved server - use another name for the group`)
  }
  for (const member of members) {
    if (store.groups.some((entry) => entry.name === member)) {
      throw new Error(`"${member}" is a group - a group holds servers, not groups`)
    }
    if (!store.servers.some((entry) => entry.name === member)) {
      throw new Error(`no server named "${member}" - add it first with imp-aly add`)
    }
  }
  const group = { name, servers: members }
  const index = store.groups.findIndex((entry) => entry.name === name)
  if (index === -1) store.groups.push(group)
  else store.groups[index] = group
  writeStore(path, store)
  return group
}

export const removeSaved = (name, path = serversPath()) => {
  const store = readStore(path)
  const found = findEntry(store, name)
  if (found.server) {
    const holder = store.groups.find((entry) => entry.servers.includes(name))
    if (holder) {
      throw new Error(
        `"${name}" is in the group "${holder.name}" - change the group with imp-aly group, or remove the group first`,
      )
    }
    store.servers = store.servers.filter((entry) => entry.name !== name)
  } else {
    store.groups = store.groups.filter((entry) => entry.name !== name)
  }
  if (store.default === name) store.default = store.servers.at(-1)?.name ?? ''
  writeStore(path, store)
  return found
}

export const useSaved = (name, path = serversPath()) => {
  const store = readStore(path)
  const found = findEntry(store, name)
  store.default = name
  writeStore(path, store)
  return found
}

const defaultNames = (store) => {
  const known = [...store.servers, ...store.groups].some((entry) => entry.name === store.default)
  return known ? [store.default] : []
}

const expandName = (store, name) => {
  const { server, group } = findEntry(store, name)
  if (server) return [server]
  return group.servers.map((member) => {
    const saved = store.servers.find((entry) => entry.name === member)
    if (!saved) {
      throw new Error(`the group "${name}" names "${member}", which is not a saved server`)
    }
    return saved
  })
}

export const resolveTargets = ({ url, auth, server }, path = serversPath()) => {
  if (url !== undefined && server !== undefined) {
    throw new Error('give --server or --url, not both')
  }
  if (url !== undefined) return [{ url: parseServerUrl(url), auth, server: null }]
  const store = readStore(path)
  const names = server === undefined ? defaultNames(store) : serverNames(server)
  const saved = names.flatMap((name) => expandName(store, name))
  if (!saved.length) return [{ url: undefined, auth, server: null }]
  const twice = saved.find((entry, index) => saved.indexOf(entry) !== index)
  if (twice) throw new Error(`"${server ?? store.default}" names the server "${twice.name}" twice`)
  return saved.map((entry) => ({ url: entry.url, auth: auth ?? entry.auth, server: entry.name }))
}

export const resolveTarget = ({ url, auth, server }, path = serversPath()) => {
  const oneServer = () => new Error(`this command takes one server, not "${server}"`)
  if (server !== undefined && serverNames(server).length > 1) throw oneServer()
  const targets = resolveTargets({ url, auth, server }, path)
  if (targets.length === 1) return targets[0]
  if (server !== undefined) throw oneServer()
  throw new Error(
    `the default "${
      readStore(path).default
    }" is a group - this command takes one server, use -s <name>`,
  )
}
