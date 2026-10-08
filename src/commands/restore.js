import { requireOnlyFlags } from '../args.js'
import { apiFetch } from '../api-client.js'
import { logger } from '../logger.js'
import { hashStream } from '../sha256.js'
import { formatTable } from '../table.js'

export const restore = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth', 'url', 'server', 'json'], 'restore')
  const [, file, ...rest] = positional
  if (!file || rest.length) throw new Error('use: imp-aly restore <file>')
  const open = () =>
    Deno.open(file).catch((error) => {
      throw new Error(`cannot read the backup ${file}: ${error.message}`)
    })
  const bodyHash = await hashStream((await open()).readable)
  const input = await open()
  const response = await apiFetch({
    url: flags.url,
    auth: flags.auth,
    server: flags.server,
    method: 'POST',
    path: '/restore',
    body: input.readable,
    bodyHash,
    contentType: 'application/gzip',
  })
  const result = await response.json()
  if (flags.json) return console.log(JSON.stringify(result, null, 2))
  logger.plain(`Restored ${result.restored.length} summaries. Skipped ${result.skipped.length}.`)
  if (result.skipped.length) {
    const columns = ['app', 'day', 'week', 'month', 'source', 'reason'].filter((column) =>
      ['app', 'source', 'reason'].includes(column) ||
      result.skipped.some((entry) => entry[column] !== undefined)
    )
    logger.plain(`\n${formatTable(columns, result.skipped)}`)
  }
}
