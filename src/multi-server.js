import { finalizeQuery, parseQuery } from './query-core.js'

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

const noServerAnswered = (failed) =>
  new ApiError(
    `no server answered:\n${failed.map((entry) => `  ${entry.reason}`).join('\n')}`,
    502,
  )

export const eachServer = async (targets, run) => {
  const results = []
  const failed = []
  for (const target of targets) {
    try {
      results.push({ server: target.label, result: await run(target) })
    } catch (error) {
      if (targets.length === 1) throw error
      failed.push({ server: target.label, reason: error.message })
    }
  }
  return { results, failed }
}

export const requireAnswer = ({ results, failed }) => {
  if (!results.length && failed.length) throw noServerAnswered(failed)
  return { results, failedServers: failed }
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

export const queryEach = async (targets, body, call) => {
  const parsed = parseQuery(body)
  const request = { ...body, from: parsed.from, to: parsed.to }
  const settled = await Promise.allSettled(
    targets.map((target) => call(target, { method: 'POST', path: '/query', body: request })),
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
    throw noServerAnswered(failedServers)
  }
  return {
    parsed,
    result: { ...finalizeQuery(parsed, answers), failedServers },
    warnings: configWarnings(parsed.app, answers),
  }
}
