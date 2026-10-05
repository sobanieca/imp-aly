import { createToken, EMPTY_BODY_HASH, findKey } from './auth.js'
import { finalizeQuery, parseQuery } from './query.js'
import { DEFAULT_ADMIN_PORT } from './server.js'
import { resolveTarget, serverNames, serversPath } from './servers.js'
import { sha256Hex } from './sha256.js'

export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_ADMIN_PORT}`

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

const toTarget = ({ url, auth, server }) => {
  const resolved = url ?? DEFAULT_URL
  return { label: server ?? resolved, url: resolved, auth, server }
}

export const resolveOne = ({ url, auth, server }, path = serversPath()) =>
  toTarget(resolveTarget({ url, auth, server }, path))

export const resolveTargets = ({ url, auth, server }, path = serversPath()) => {
  const names = server === undefined ? [undefined] : serverNames(server)
  return names.map((name) => toTarget(resolveTarget({ url, auth, server: name }, path)))
}

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

export const eachServer = async (targets, run) => {
  const results = []
  const failed = []
  for (const target of targets) {
    const call = (method, path, body) => callServer(target, { method, path, body })
    try {
      results.push({ server: target.label, result: await run(call) })
    } catch (error) {
      if (targets.length === 1) throw error
      failed.push({ server: target.label, reason: error.message })
    }
  }
  return { results, failed }
}

const configWarnings = (app, answers) => {
  const missing = answers.filter(({ answer }) => answer.appConfig === null)
  const configs = new Set(
    answers.filter(({ answer }) => answer.appConfig !== null).map(({ answer }) => answer.appConfig),
  )
  const warnings = []
  if (missing.length && missing.length < answers.length) {
    const names = missing.map(({ server }) => server).join(', ')
    warnings.push(`the app ${app} is not registered on: ${names}`)
  }
  if (configs.size > 1) {
    warnings.push(
      `the app ${app} has different builds or different segments on the servers`,
    )
  }
  return warnings
}

export const queryServers = async (targets, body) => {
  const parsed = parseQuery(body)
  const request = { ...body, from: parsed.from, to: parsed.to }
  const settled = await Promise.allSettled(
    targets.map((target) => callServer(target, { method: 'POST', path: '/query', body: request })),
  )
  const answers = []
  const failedServers = []
  settled.forEach((outcome, index) => {
    const server = targets[index].label
    if (outcome.status === 'fulfilled') answers.push({ server, answer: outcome.value })
    else failedServers.push({ server, reason: outcome.reason.message })
  })
  if (!answers.length) {
    if (settled.length === 1) throw settled[0].reason
    throw new ApiError(
      `no server answered:\n${failedServers.map((entry) => `  ${entry.reason}`).join('\n')}`,
      502,
    )
  }
  return {
    parsed,
    result: { ...finalizeQuery(parsed, answers), failedServers },
    warnings: configWarnings(parsed.app, answers),
  }
}
