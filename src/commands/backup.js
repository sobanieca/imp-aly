import { requireOnlyFlags } from '../args.js'
import { apiFetch } from '../api-client.js'
import { BACKUP_KINDS, BACKUP_PERIODS, countBackup } from '../backup.js'
import { removeIfExists } from '../fs-utils.js'
import { logger } from '../logger.js'

const USAGE = 'use: imp-aly backup <file> [--last <period>] [--by day|week|month] [-s <name>]'

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`

const SUMMARY_NAMES = {
  days: ['daily summary', 'daily summaries'],
  weeks: ['week summary', 'week summaries'],
  months: ['month summary', 'month summaries'],
}

const EMPTY_HINTS = {
  day: 'No sealed day is in the period. A day is sealed at 01:10 UTC of the next day.',
  week:
    'No complete week is in the period. A week is complete at 01:10 UTC on Monday, and all its days must be in the period.',
  month:
    'No complete month is in the period. A month is complete at 01:10 UTC on the first day of the next month, and all its days must be in the period.',
}

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
  requireOnlyFlags(flags, ['auth', 'url', 'server', 'last', 'by'], 'backup')
  const [, file, ...rest] = positional
  if (!file || rest.length) throw new Error(USAGE)
  const last = flags.last ?? 'all'
  const by = flags.by ?? 'day'
  if (!Object.hasOwn(BACKUP_PERIODS, last)) {
    throw new Error(`--last is one of ${Object.keys(BACKUP_PERIODS).join(', ')}`)
  }
  if (!Object.hasOwn(BACKUP_KINDS, by)) {
    throw new Error(`--by is one of ${Object.keys(BACKUP_KINDS).join(', ')}`)
  }
  const params = new URLSearchParams({ last, by })
  const response = await apiFetch({
    url: flags.url,
    auth: flags.auth,
    server: flags.server,
    method: 'GET',
    path: `/backup?${params}`,
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
  const kinds = Object.keys(SUMMARY_NAMES).filter((kind) => counted[kind])
  const summaries = (kinds.length ? kinds : [BACKUP_KINDS[by]])
    .map((kind) => plural(counted[kind], ...SUMMARY_NAMES[kind]))
    .join(', ')
  const apps = plural(counted.apps, 'app')
  const sources = plural(counted.sources, 'source')
  logger.plain(`Saved ${summaries} of ${apps} and ${sources} to ${file} (${formatBytes(size)})`)
  if (!kinds.length) logger.plain(EMPTY_HINTS[by])
}
