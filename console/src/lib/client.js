import { HttpError } from 'imp/http'
import { eachServer, queryEach, requireAnswer } from '../../../src/multi-server.js'
import { createSha256, sha256Hex } from '../../../src/sha256.js'
import { createToken, EMPTY_BODY_HASH } from '../../../src/token.js'
import { targetsOf } from './vault.js'

const QUERY_TIMEOUT_MS = 130_000

const encoder = new TextEncoder()

const hashBlob = async (blob) => {
  const hash = createSha256()
  const reader = blob.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return hash.digest()
    hash.update(value)
  }
}

export const hashBody = (body) => {
  if (body === null || body === undefined) return EMPTY_BODY_HASH
  if (typeof body === 'string') return sha256Hex(encoder.encode(body))
  if (body instanceof Blob) return hashBlob(body)
  throw new Error('the console signs only a text or a file as the body')
}

export const signedPath = (requestUrl, serverUrl) => {
  const url = new URL(requestUrl)
  const prefix = new URL(serverUrl).pathname.replace(/\/+$/, '')
  return `${url.pathname.slice(prefix.length)}${url.search}`
}

const signRequest = async (request) => {
  const target = request.meta?.target
  if (!target) return request
  const token = await createToken(target.key, {
    method: request.method,
    path: signedPath(request.url, target.url),
    bodyHash: await hashBody(request.body),
  })
  request.headers.authorization = `Bearer ${token}`
  return request
}

export const CLIENT_OPTIONS = {
  requestId: false,
  timeout: QUERY_TIMEOUT_MS,
  onRequest: signRequest,
}

const reachHint = (target) =>
  globalThis.location?.protocol === 'https:' && target.url.startsWith('http:')
    ? 'this page uses https, so the server must use https too'
    : 'is the server running, and does it allow the address of this page?'

const serverError = (error, target, method, path) => {
  const where = `server "${target.name}" (${target.url})`
  if (!(error instanceof HttpError)) return error
  if (error.code === 'aborted') return error
  if (error.code === 'timeout') return new Error(`${where} did not answer in time`)
  if (error.code === 'network') return new Error(`cannot reach ${where} - ${reachHint(target)}`)
  const message = error.body?.error ?? (typeof error.body === 'string' ? error.body.trim() : '')
  const failure = new Error(`${method} ${path} on ${where} answered ${error.status}: ${message}`)
  failure.status = error.status
  return failure
}

const callServer = async (api, target, { method, path, body, ...options }) => {
  try {
    return await api.request(`${target.url}${path}`, {
      method,
      body,
      meta: { target },
      ...options,
    }).then((response) => response.body)
  } catch (error) {
    throw serverError(error, target, method, path)
  }
}

export const queryServers = async (api, names, body, options = {}) => {
  const targets = await targetsOf(names)
  const { result, warnings } = await queryEach(
    targets,
    body,
    (target, request) => callServer(api, target, { ...request, ...options }),
  )
  return { ...result, warnings }
}

const onServers = async (api, names, method, path, body) => {
  const targets = await targetsOf(names)
  return requireAnswer(
    await eachServer(targets, (target) => callServer(api, target, { method, path, body })),
  )
}

export const appsOf = async (api, names) => {
  const { results, failedServers } = await onServers(api, names, 'GET', '/apps')
  const apps = results.flatMap(({ server, result }) =>
    result.apps.map((entry) => ({ server, ...entry }))
  )
  return { apps, failedServers }
}

export const appOnServers = async (api, names, method, path, body) => {
  const { results, failedServers } = await onServers(api, names, method, path, body)
  return { apps: results.map(({ server, result }) => ({ server, ...result })), failedServers }
}

export const statusOf = async (api, name) => {
  const [target] = await targetsOf(name ? [name] : [])
  const status = await callServer(api, target, { method: 'GET', path: '/status' })
  return { server: target.name, url: target.url, ...status }
}

export const downloadBackup = async (api, name, { app, from, to } = {}) => {
  const [target] = await targetsOf(name ? [name] : [])
  const params = new URLSearchParams()
  for (const [field, value] of Object.entries({ app, from, to })) {
    if (value) params.set(field, value)
  }
  const path = params.size ? `/backup?${params}` : '/backup'
  const blob = await callServer(api, target, { method: 'GET', path, timeout: 0 })
  const day = new Date().toISOString().slice(0, 10)
  const label = target.name.replace(/[^A-Za-z0-9._-]+/g, '-')
  return { blob, fileName: `imp-aly-backup-${label}-${day}.tar.gz` }
}

export const restoreBackup = async (api, name, file) => {
  const [target] = await targetsOf(name ? [name] : [])
  const answer = await callServer(api, target, {
    method: 'POST',
    path: '/restore',
    body: file,
    headers: { 'content-type': 'application/gzip' },
    timeout: 0,
  })
  return { server: target.name, ...answer }
}
