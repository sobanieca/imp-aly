import { requireOnlyFlags } from '../args.js'
import { callApi } from '../api-client.js'
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
  requireOnlyFlags(flags, ['auth', 'url', 'json'], 'query')
  const [, argument, ...rest] = positional
  if (!argument || rest.length) {
    throw new Error(`use: imp-analytics-server query '<json>' or query <file.json>`)
  }
  const body = await readQuery(argument)
  const result = await callApi({
    url: flags.url,
    auth: flags.auth,
    method: 'POST',
    path: '/query',
    body,
  })
  if (flags.json) return console.log(JSON.stringify(result, null, 2))
  const columns = [...(body.groupBy ?? []), ...(body.measures ?? ['records'])]
  logger.plain(formatTable(columns, result.rows))
  logger.plain(
    `\n${result.rows.length} rows${
      result.truncated ? ' (truncated by limit)' : ''
    } | ${result.days} days | ${result.scanned} records scanned | ${result.matched} matched`,
  )
}
