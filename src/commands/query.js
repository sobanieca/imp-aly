import { requireOnlyFlags } from '../args.js'
import { callApi, resolveTargets } from '../api-client.js'
import { logger } from '../logger.js'
import { finalizeQuery, parseQuery } from '../query.js'
import { formatTable } from '../table.js'

const readQuery = async (argument) => {
  const text = argument.trim().startsWith('{')
    ? argument
    : await Deno.readTextFile(argument).catch((error) => {
      throw new Error(`"${argument}" is not a JSON query and not a readable file: ${error.message}`)
    })
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('the query is not valid JSON')
  }
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
    warnings.push(`the app ${app} has a different map or different segments on the servers`)
  }
  return warnings
}

export const query = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth', 'url', 'server', 'json'], 'query')
  const [, argument, ...rest] = positional
  if (!argument || rest.length) {
    throw new Error(`use: imp-aly query '<json>' or query <file.json>`)
  }
  const body = await readQuery(argument)
  const parsed = parseQuery(body)
  const request = { ...body, from: parsed.from, to: parsed.to }
  const targets = resolveTargets(flags)
  const settled = await Promise.allSettled(
    targets.map(({ url, auth, server }) =>
      callApi({ url, auth, server, method: 'POST', path: '/query', body: request })
    ),
  )
  const answers = []
  const failedServers = []
  settled.forEach((outcome, index) => {
    const server = targets[index].label
    if (outcome.status === 'fulfilled') answers.push({ server, answer: outcome.value })
    else failedServers.push({ server, reason: outcome.reason.message })
  })
  if (!answers.length) {
    if (failedServers.length === 1) throw new Error(failedServers[0].reason)
    throw new Error(
      `no server answered:\n${failedServers.map((entry) => `  ${entry.reason}`).join('\n')}`,
    )
  }
  const result = { ...finalizeQuery(parsed, answers), failedServers }
  const warnings = configWarnings(parsed.app, answers)
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    const columns = [...parsed.groupBy, ...parsed.measures]
    logger.plain(formatTable(columns, result.rows))
    logger.plain(
      `\n${result.rows.length} rows${
        result.truncated ? ' (truncated by limit)' : ''
      } | ${result.days} days | ${result.scanned} records scanned | ${result.matched} matched`,
    )
    if (targets.length > 1) {
      logger.plain('')
      logger.plain(formatTable(['server', 'days', 'summaryDays', 'scanned', 'matched'], [
        ...result.servers,
        ...failedServers.map(({ server }) => ({ server })),
      ]))
    }
    if (result.skippedDays.length) {
      logger.plain(`\nSkipped ${result.skippedDays.length} days that the query cannot read:`)
      const columns = targets.length > 1 ? ['server', 'day', 'reason'] : ['day', 'reason']
      logger.plain(formatTable(columns, result.skippedDays))
    }
  }
  for (const warning of warnings) logger.warn(warning)
  if (failedServers.length) {
    throw new Error(
      `the result is not complete - ${failedServers.length} of ${targets.length} servers did not answer:\n${
        failedServers.map((entry) => `  ${entry.reason}`).join('\n')
      }`,
    )
  }
}
