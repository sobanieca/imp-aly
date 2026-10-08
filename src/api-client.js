import { findKey } from './auth.js'
import { ApiError, eachServer as eachTarget, queryEach } from './multi-server.js'
import { DEFAULT_ADMIN_PORT } from './server.js'
import { resolveTarget, resolveTargets as resolveSaved, serversPath } from './servers.js'
import { sha256Hex } from './sha256.js'
import { createToken, EMPTY_BODY_HASH } from './token.js'

export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_ADMIN_PORT}`

const toTarget = ({ url, auth, server }) => {
  const resolved = url ?? DEFAULT_URL
  return { label: server ?? resolved, url: resolved, auth, server }
}

export const resolveOne = ({ url, auth, server }, path = serversPath()) =>
  toTarget(resolveTarget({ url, auth, server }, path))

export const resolveTargets = ({ url, auth, server }, path = serversPath()) =>
  resolveSaved({ url, auth, server }, path).map(toTarget)

export const fetchServer = async (
  target,
  { method, path, body, bodyHash, contentType = 'application/json' },
) => {
  const where = target.server ? `server "${target.server}" (${target.url})` : target.url
  const key = findKey(target.auth)
  const hash = bodyHash ??
    (typeof body === 'string' ? sha256Hex(new TextEncoder().encode(body)) : EMPTY_BODY_HASH)
  const headers = {
    authorization: `Bearer ${await createToken(key, { method, path, bodyHash: hash })}`,
  }
  if (body !== undefined) headers['content-type'] = contentType
  let response
  try {
    response = await fetch(`${target.url.replace(/\/+$/, '')}${path}`, { method, headers, body })
  } catch (error) {
    throw new ApiError(`cannot reach ${where} - is the server running? (${error.message})`, 0)
  }
  if (!response.ok) {
    const text = await response.text()
    let message = text.trim()
    try {
      message = JSON.parse(text).error ?? message
    } catch {
      message = text.trim()
    }
    throw new ApiError(
      `${method} ${path} on ${where} answered ${response.status}: ${message}`,
      response.status,
    )
  }
  return response
}

export const callServer = async (target, { body, ...request }) => {
  const response = await fetchServer(target, {
    ...request,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { error: text.trim() }
  }
}

export const apiFetch = ({ url, auth, server, ...request }) =>
  fetchServer(resolveOne({ url, auth, server }), request)

export const callApi = ({ url, auth, server, ...request }) =>
  callServer(resolveOne({ url, auth, server }), request)

export const eachServer = (targets, run) =>
  eachTarget(
    targets,
    (target) => run((method, path, body) => callServer(target, { method, path, body })),
  )

export const queryServers = (targets, body) => queryEach(targets, body, callServer)
