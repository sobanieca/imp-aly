import { isName, isRoutePattern } from './records.js'

export const BUILD_FILE = 'app-analytics.json'

export const MAX_FILE_BYTES = 3_145_728

export const MAX_LIST_ENTRIES = 10_000

const FETCH_TIMEOUT_MS = 10_000

const LISTS = {
  pages: {
    plural: 'route patterns',
    expected: 'a route pattern - it starts with "/", like /invoices/:id',
    isValid: isRoutePattern,
  },
  zones: {
    plural: 'zone names',
    expected: 'a zone name - a namespaced name, like myapp.send',
    isValid: isName,
  },
  outcomes: {
    plural: 'outcome names',
    expected: 'an outcome name - a namespaced name, like myapp.sent',
    isValid: isName,
  },
}

const SHAPE = `an object of three lists, like {"pages": ["/"], "zones": [], "outcomes": []}`

const readList = (build, key) => {
  const { plural, expected, isValid } = LISTS[key]
  const list = build[key]
  if (!Array.isArray(list)) throw new Error(`${BUILD_FILE} has no "${key}" list - it is ${SHAPE}`)
  if (list.length > MAX_LIST_ENTRIES) {
    throw new Error(`${BUILD_FILE} has more than ${MAX_LIST_ENTRIES} ${plural} in "${key}"`)
  }
  list.forEach((value, index) => {
    if (typeof value !== 'string' || !isValid(value)) {
      throw new Error(
        `${BUILD_FILE} ${key}[${index}] ${JSON.stringify(value).slice(0, 80)} is not ${expected}`,
      )
    }
  })
  return [...new Set(list)].sort()
}

export const parseBuild = (text) => {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    throw new Error(`${BUILD_FILE} is larger than ${MAX_FILE_BYTES} bytes`)
  }
  let build
  try {
    build = JSON.parse(text)
  } catch {
    throw new Error(`${BUILD_FILE} is not JSON - it is ${SHAPE}`)
  }
  if (build === null || typeof build !== 'object' || Array.isArray(build)) {
    throw new Error(`${BUILD_FILE} is not ${SHAPE}`)
  }
  const pages = readList(build, 'pages')
  if (!pages.length) throw new Error(`${BUILD_FILE} has no route pattern in "pages"`)
  return { pages, zones: readList(build, 'zones'), outcomes: readList(build, 'outcomes') }
}

export const readLimitedText = async (response, maxBytes) => {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error(`the response is larger than ${maxBytes} bytes`)
  }
  const chunks = []
  let total = 0
  for await (const chunk of response.body ?? []) {
    total += chunk.length
    if (total > maxBytes) throw new Error(`the response is larger than ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(bytes)
}

export const fetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`GET ${url} answered ${response.status}`)
  }
  try {
    return await readLimitedText(response, MAX_FILE_BYTES)
  } catch (error) {
    throw new Error(`GET ${url}: ${error.message}`)
  }
}

export const folderUrl = (value) => {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.search || url.hash || url.username || url.password) return null
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

export const buildFileUrl = (appUrl) => new URL(BUILD_FILE, appUrl).href

export const fetchBuild = async (appUrl, fetchFile = fetchText) =>
  parseBuild(await fetchFile(buildFileUrl(appUrl)))
