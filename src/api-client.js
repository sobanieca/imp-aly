import { findKey } from './auth.js'
import {
  ApiError,
  CALL_TIMEOUT_MS,
  eachServer as eachTarget,
  QUERY_TIMEOUT_MS,
  queryEach,
} from './multi-server.js'
import { DEFAULT_ADMIN_PORT } from './server.js'
import { resolveTarget, resolveTargets as resolveSaved, serversPath } from './servers.js'
import { sha256Hex } from './sha256.js'
import { createToken, EMPTY_BODY_HASH } from './token.js'

export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_ADMIN_PORT}`

const toTarget = ({ url, auth, server, service = false }) => {
  const resolved = url ?? DEFAULT_URL
  return { label: server ?? resolved, url: resolved, auth, server, service }
}

export const resolveOne = (flags, path = serversPath(), local) =>
  toTarget(resolveTarget(flags, path, local))

export const resolveTargets = (flags, path = serversPath(), local) =>
  resolveSaved(flags, path, local).map(toTarget)

const whereOf = (target) => target.server ? `server "${target.server}" (${target.url})` : target.url

const keyOf = (target) => {
  try {
    return findKey(target.auth)
  } catch (error) {
    if (!target.service) throw error
    throw new Error(
      `${error.message} - the local service reads its key from this file, so run the command with sudo, or pass -a <key>`,
    )
  }
}

const reachHint = (target) =>
  target.service && target.url.startsWith('https:')
    ? 'the local service uses TLS, so pass --url https://<host in the certificate>:<admin port>'
    : 'is the server running?'

const isTimeout = (error) => error?.name === 'TimeoutError'

const lateAnswer = (target, timeoutMs) =>
  new ApiError(`${whereOf(target)} did not answer in ${timeoutMs / 1000} s`, 0)

const readText = async (response, target, timeoutMs) => {
  try {
    return await response.text()
  } catch (error) {
    if (isTimeout(error)) throw lateAnswer(target, timeoutMs)
    throw new ApiError(`cannot read the answer of ${whereOf(target)} (${error.message})`, 0)
  }
}

export const fetchServer = async (
  target,
  {
    method,
    path,
    body,
    bodyHash,
    contentType = 'application/json',
    timeoutMs = CALL_TIMEOUT_MS,
  },
) => {
  const where = whereOf(target)
  const key = keyOf(target)
  const hash = bodyHash ??
    (typeof body === 'string' ? sha256Hex(new TextEncoder().encode(body)) : EMPTY_BODY_HASH)
  const headers = {
    authorization: `Bearer ${await createToken(key, { method, path, bodyHash: hash })}`,
  }
  if (body !== undefined) headers['content-type'] = contentType
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
  let response
  try {
    response = await fetch(`${target.url.replace(/\/+$/, '')}${path}`, {
      method,
      headers,
      body,
      signal,
    })
  } catch (error) {
    if (isTimeout(error)) throw lateAnswer(target, timeoutMs)
    throw new ApiError(`cannot reach ${where} - ${reachHint(target)} (${error.message})`, 0)
  }
  if (!response.ok) {
    const text = await readText(response, target, timeoutMs)
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

export const readJson = async (response, target, { method, path, timeoutMs = 0 }) => {
  const text = await readText(response, target, timeoutMs)
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(
      `${method} ${path} on ${
        whereOf(target)
      } answered ${response.status} with a reply that is not JSON`,
      502,
    )
  }
}

export const callServer = async (target, { body, timeoutMs = CALL_TIMEOUT_MS, ...request }) => {
  const response = await fetchServer(target, {
    ...request,
    timeoutMs,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return readJson(response, target, { ...request, timeoutMs })
}

export const apiFetch = ({ url, auth, server, ...request }) =>
  fetchServer(resolveOne({ url, auth, server }), request)

export const callApi = ({ url, auth, server, ...request }) =>
  callServer(resolveOne({ url, auth, server }), request)

export const eachServer = (targets, run, { timeoutMs = CALL_TIMEOUT_MS } = {}) =>
  eachTarget(
    targets,
    (target) => run((method, path, body) => callServer(target, { method, path, body, timeoutMs })),
  )

export const queryServers = (targets, body, { timeoutMs = QUERY_TIMEOUT_MS } = {}) =>
  queryEach(targets, body, (target, request) => callServer(target, { ...request, timeoutMs }))
