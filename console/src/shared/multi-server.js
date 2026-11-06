import { finalizeQuery, parseQuery } from './query-core.js'

export const QUERY_TIMEOUT_MS = 130_000

export const CALL_TIMEOUT_MS = 30_000

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

const noServerAnswered = (failed) =>
  new ApiError(`no server answered:\n${failed.map((entry) => `  ${entry.reason}`).join('\n')}`, 502)

const reasonOf = (error) => error?.message ?? String(error)

export const eachServer = async (targets, run) => {
  const settled = await Promise.allSettled(targets.map(async (target) => await run(target)))
  if (targets.length === 1 && settled[0].status === 'rejected') throw settled[0].reason
  const results = []
  const failed = []
  settled.forEach((outcome, index) => {
    const server = targets[index].label
    if (outcome.status === 'fulfilled') results.push({ server, result: outcome.value })
    else failed.push({ server, reason: reasonOf(outcome.reason) })
  })
  return { results, failed }
}

export const requireAnswer = ({ results, failed }) => {
  if (!results.length && failed.length) throw noServerAnswered(failed)
  return { results, failedServers: failed }
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0

const isGroup = (group) =>
  group !== null && typeof group === 'object' && Array.isArray(group.by) && isCount(group.records)

const isQueryAnswer = (answer) =>
  answer !== null
  && typeof answer === 'object'
  && !Array.isArray(answer)
  && Array.isArray(answer.days)
  && Array.isArray(answer.groups)
  && answer.groups.every(isGroup)
  && Array.isArray(answer.skippedDays)
  && isCount(answer.scanned)
  && isCount(answer.matched)

const notAnAnswer = (server) =>
  new ApiError(`${server} sent a reply that is not a query answer`, 502)

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
    warnings.push(`the app ${app} has different builds or different segments on the servers`)
  }
  return warnings
}

export const queryEach = async (targets, body, call) => {
  const parsed = parseQuery(body)
  const request = { ...body, from: parsed.from, to: parsed.to }
  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      const answer = await call(target, { method: 'POST', path: '/query', body: request })
      if (!isQueryAnswer(answer)) throw notAnAnswer(target.label)
      return answer
    }),
  )
  const answers = []
  const failedServers = []
  settled.forEach((outcome, index) => {
    const server = targets[index].label
    if (outcome.status === 'fulfilled') answers.push({ server, answer: outcome.value })
    else failedServers.push({ server, reason: reasonOf(outcome.reason) })
  })
  if (!answers.length) {
    if (settled.length === 1) throw settled[0].reason
    throw noServerAnswered(failedServers)
  }
  return {
    parsed,
    result: { ...finalizeQuery(parsed, answers), failedServers },
    warnings: configWarnings(parsed.app, answers),
  }
}
