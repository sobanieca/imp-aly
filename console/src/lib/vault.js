import { importSigningKey } from '../shared/token.js'

const DB_NAME = 'imp-aly-console'

const SERVERS = 'servers'

export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

let opened = null

const openDb = () => {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SERVERS, { keyPath: 'name' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      opened = null
      reject(request.error ?? new Error('the browser storage cannot be opened'))
    }
  })
  return opened
}

const done = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const abortOf = (tx) => {
  try {
    tx.abort()
    return null
  } catch (error) {
    return error
  }
}

export const runTransaction = async (tx, run) => {
  const finished = new Promise((resolve, reject) => {
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('the browser storage refused the change'))
  })
  try {
    const result = await run(tx.objectStore(SERVERS))
    await finished
    return result
  } catch (error) {
    finished.catch(() => null)
    abortOf(tx)
    throw error
  }
}

const transaction = async (mode, run) => {
  const db = await openDb()
  return runTransaction(db.transaction(SERVERS, mode), run)
}

const readAll = () =>
  transaction('readonly', async (servers) => {
    const entries = await done(servers.getAll())
    return entries.sort((a, b) => a.added - b.added)
  })

export const loadServers = async () => ({
  servers: (await readAll()).map(({ name, url }) => ({ name, url })),
})

export const parseServerUrl = (value, pageProtocol = globalThis.location?.protocol) => {
  let url
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    url = null
  }
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`"${value}" is not a server URL - use https://host:port`)
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`"${value}" must not have a query, a fragment or a user`)
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (pageProtocol === 'https:' && url.protocol === 'http:' && !local) {
    throw new Error('this page uses https, so the browser calls only servers with https')
  }
  return url.href.replace(/\/+$/, '')
}

export const saveServer = async ({ name, url, key }) => {
  if (!SERVER_NAME.test(String(name ?? ''))) {
    throw new Error(`"${name}" is not a server name - use letters, digits, ".", "_" and "-"`)
  }
  const href = parseServerUrl(url)
  const text = String(key ?? '').trim()
  const signingKey = text ? await importSigningKey(text) : null
  await transaction('readwrite', async (servers) => {
    const found = await done(servers.get(name))
    if (!signingKey && !found) throw new Error('a new server needs its key')
    servers.put({
      name,
      url: href,
      key: signingKey ?? found.key,
      added: found?.added ?? Date.now(),
    })
  })
  await navigator.storage?.persist?.().catch(() => false)
  return { name, url: href }
}

export const removeServer = (name) =>
  transaction('readwrite', (servers) => {
    servers.delete(name)
  })

export const targetsOf = async (names) => {
  if (!names.length) throw new Error('no server is chosen - add one in Servers')
  const entries = await readAll()
  return names.map((name) => {
    const entry = entries.find((item) => item.name === name)
    if (!entry) throw new Error(`no server named "${name}" - see Servers`)
    return { label: name, name, url: entry.url, key: entry.key }
  })
}
