import { isSafeText } from './records.js'

export const MAX_MAP_BYTES = 1_048_576

export const MAX_MAP_PAGES = 10_000

const MAX_PATTERN_LENGTH = 512

const FETCH_TIMEOUT_MS = 10_000

export const parseAppMap = (text) => {
  const pages = text.split('\n').map((line) => line.replace(/\r$/, '').trim()).filter(Boolean)
  if (!pages.length) throw new Error('the app map has no route pattern')
  if (pages.length > MAX_MAP_PAGES) {
    throw new Error(`the app map has more than ${MAX_MAP_PAGES} route patterns`)
  }
  for (const page of pages) {
    if (!page.startsWith('/') || page.length > MAX_PATTERN_LENGTH || !isSafeText(page)) {
      throw new Error(
        `the app map line "${
          page.slice(0, 80)
        }" is not a route pattern - each line starts with "/", like /invoices/:id`,
      )
    }
  }
  return [...new Set(pages)]
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

export const fetchAppMap = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`GET ${url} answered ${response.status}`)
  }
  return parseAppMap(await readLimitedText(response, MAX_MAP_BYTES))
}
