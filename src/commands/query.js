import { parseTimeout, requireOnlyFlags } from '../args.js'
import { queryServers, resolveTargets } from '../api-client.js'
import { logger } from '../logger.js'
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

export const query = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth', 'url', 'server', 'json', 'timeout'], 'query')
  const [, argument, ...rest] = positional
  if (!argument || rest.length) {
    throw new Error(`use: imp-aly query '<json>' or query <file.json>`)
  }
  const timeoutMs = parseTimeout(flags.timeout)
  const body = await readQuery(argument)
  const targets = resolveTargets(flags)
  const { parsed, result, warnings } = await queryServers(targets, body, { timeoutMs })
  const { failedServers } = result
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
      const columns = targets.length > 1
        ? ['server', 'day', 'source', 'reason']
        : ['day', 'source', 'reason']
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
