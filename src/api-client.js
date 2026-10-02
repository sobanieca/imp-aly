import { createToken, EMPTY_BODY_HASH, findKey } from './auth.js'
import { DEFAULT_ADMIN_PORT } from './server.js'
import { resolveTarget, serverNames } from './servers.js'
import { sha256Hex } from './sha256.js'

export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_ADMIN_PORT}`

export const apiFetch = async (
  { url, auth, server, method, path, body, bodyHash, contentType = 'application/json' },
) => {
  const target = resolveTarget({ url, auth, server })
  url = target.url ?? DEFAULT_URL
  const where = target.server ? `server "${target.server}" (${url})` : url
  const key = findKey(target.auth)
  const hash = bodyHash ??
    (typeof body === 'string' ? sha256Hex(new TextEncoder().encode(body)) : EMPTY_BODY_HASH)
  const headers = {
    authorization: `Bearer ${await createToken(key, { method, path, bodyHash: hash })}`,
  }
  if (body !== undefined) headers['content-type'] = contentType
  let response
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}${path}`, { method, headers, body })
  } catch (error) {
    throw new Error(`cannot reach ${where} - is the server running? (${error.message})`)
  }
  if (!response.ok) {
    const text = await response.text()
    let message = text.trim()
    try {
      message = JSON.parse(text).error ?? message
    } catch {
      message = text.trim()
    }
    throw new Error(`${method} ${path} on ${where} answered ${response.status}: ${message}`)
  }
  return response
}

export const resolveTargets = ({ url, auth, server }) => {
  const names = server === undefined ? [undefined] : serverNames(server)
  return names.map((name) => {
    const target = resolveTarget({ url, auth, server: name })
    return { label: target.server ?? target.url ?? DEFAULT_URL, url, auth, server: name }
  })
}

export const callApi = async ({ body, ...options }) => {
  const response = await apiFetch({
    ...options,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { error: text.trim() }
  }
}
