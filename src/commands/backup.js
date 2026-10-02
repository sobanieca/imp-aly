import { requireOnlyFlags } from '../args.js'
import { apiFetch } from '../api-client.js'
import { countBackup } from '../backup.js'
import { removeIfExists } from '../fs-utils.js'
import { logger } from '../logger.js'

const USAGE = 'use: imp-aly backup <file> [--app <name>] [--from <day>] [--to <day>]'

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

const formatBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`
}

export const backup = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth', 'url', 'server', 'app', 'from', 'to'], 'backup')
  const [, file, ...rest] = positional
  if (!file || rest.length) throw new Error(USAGE)
  const params = new URLSearchParams()
  for (const name of ['app', 'from', 'to']) {
    if (flags[name] !== undefined) params.set(name, flags[name])
  }
  const response = await apiFetch({
    url: flags.url,
    auth: flags.auth,
    server: flags.server,
    method: 'GET',
    path: params.size ? `/backup?${params}` : '/backup',
  })
  const temporary = `${file}.tmp`
  const [toFile, toCheck] = response.body.tee()
  let counted
  try {
    const output = await Deno.open(temporary, { write: true, create: true, truncate: true })
    const results = await Promise.all([toFile.pipeTo(output.writable), countBackup(toCheck)])
    counted = results[1]
    await Deno.rename(temporary, file)
  } catch (error) {
    await removeIfExists(temporary)
    throw new Error(`the backup failed: ${error.message}`)
  }
  const { size } = await Deno.stat(file)
  const days = plural(counted.days, 'day')
  const apps = plural(counted.apps, 'app')
  logger.plain(`Saved the daily summaries of ${days} of ${apps} to ${file} (${formatBytes(size)})`)
  if (!counted.days) {
    logger.plain('No sealed day matched. A day is sealed at 01:10 UTC of the next day.')
  }
}
