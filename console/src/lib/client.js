import { HttpError } from 'imp/http'
import {
  CALL_TIMEOUT_MS,
  eachServer,
  QUERY_TIMEOUT_MS,
  queryEach,
  requireAnswer,
} from '../shared/multi-server.js'
import { sha256Hex } from '../shared/sha256.js'
import { createToken, EMPTY_BODY_HASH } from '../shared/token.js'
import { markAnswered, noteOutcome } from './health.js'
import { targetsOf } from './vault.js'

const encoder = new TextEncoder()

export const hashBody = (body) => {
  if (body === null || body === undefined) return EMPTY_BODY_HASH
  if (typeof body === 'string') return sha256Hex(encoder.encode(body))
  throw new Error('the console signs only a text as the body')
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
    bodyHash: hashBody(request.body),
  })
  request.headers.authorization = `Bearer ${token}`
  return request
}

export const CLIENT_OPTIONS = {
  requestId: false,
  timeout: CALL_TIMEOUT_MS,
  onRequest: signRequest,
}

const reachHint = (target) =>
  globalThis.location?.protocol === 'https:' && target.url.startsWith('http:')
    ? 'this page uses https, so the server must use https too'
    : 'is the server running, and does it allow the address of this page?'

const notJson = (where, method, path, status) =>
  new Error(`${method} ${path} on ${where} answered ${status} with a reply that is not JSON`)

const serverError = (error, target, method, path) => {
  const where = `server "${target.name}" (${target.url})`
  if (!(error instanceof HttpError)) return error
  if (error.code === 'aborted') return error
  if (error.code === 'timeout') return new Error(`${where} did not answer in time`)
  if (error.code === 'network') return new Error(`cannot reach ${where} - ${reachHint(target)}`)
  if (error.code === 'parse') return notJson(where, method, path, error.status)
  const message = error.body?.error ?? (typeof error.body === 'string' ? error.body.trim() : '')
  const failure = new Error(`${method} ${path} on ${where} answered ${error.status}: ${message}`)
  failure.status = error.status
  return failure
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob)

const callServer = async (api, target, { method, path, body, timeout = CALL_TIMEOUT_MS }) => {
  let response
  try {
    response = await api.request(`${target.url}${path}`, {
      method,
      body,
      timeout,
      meta: { target },
    })
  } catch (error) {
    const failure = serverError(error, target, method, path)
    noteOutcome(target.name, failure)
    throw failure
  }
  if (!isObject(response.body)) {
    const failure = notJson(
      `server "${target.name}" (${target.url})`,
      method,
      path,
      response.status,
    )
    noteOutcome(target.name, failure)
    throw failure
  }
  markAnswered(target.name)
  return response.body
}

export const queryServers = async (api, names, body) => {
  const targets = await targetsOf(names)
  const { result, warnings } = await queryEach(targets, body, (target, request) =>
    callServer(api, target, { ...request, timeout: QUERY_TIMEOUT_MS }),
  )
  return { ...result, warnings }
}

const onServers = async (api, names, run) => {
  const targets = await targetsOf(names)
  return requireAnswer(await eachServer(targets, (target) => run(target)))
}

const appListOf = async (api, target) => {
  const result = await callServer(api, target, { method: 'GET', path: '/apps' })
  if (!Array.isArray(result.apps)) {
    throw new Error(`server "${target.name}" (${target.url}) sent no list of apps`)
  }
  return result
}

export const appsOf = async (api, names) => {
  const { results, failedServers } = await onServers(api, names, (target) => appListOf(api, target))
  const apps = results.flatMap(({ server, result }) =>
    result.apps.map((entry) => ({ server, ...entry })),
  )
  return { apps, failedServers }
}

export const appOnServers = async (api, names, method, path, body) => {
  const { results, failedServers } = await onServers(api, names, (target) =>
    callServer(api, target, { method, path, body }),
  )
  return { apps: results.map(({ server, result }) => ({ server, ...result })), failedServers }
}

export const statusOf = async (api, name) => {
  const [target] = await targetsOf([name])
  const status = await callServer(api, target, { method: 'GET', path: '/status' })
  return { server: target.name, url: target.url, ...status }
}
