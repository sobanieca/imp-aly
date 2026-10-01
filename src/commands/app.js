import { requireOnlyFlags } from '../args.js'
import { callApi } from '../api-client.js'
import { logger } from '../logger.js'
import { formatTable } from '../table.js'

const USAGE = `use one of:
  imp-analytics-server app add <name> <app-map url or file> [--segments plan,role]
  imp-analytics-server app ls
  imp-analytics-server app show <name>
  imp-analytics-server app refresh <name>
  imp-analytics-server app rm <name>`

const isUrl = (value) => /^https?:\/\//i.test(value)

const summary = (app) =>
  `${app.name}: ${app.pages} pages, segments ${
    app.segments.length ? app.segments.join(', ') : '-'
  }, map ${app.mapUrl ?? 'uploaded'}`

export const app = async ({ positional, flags }) => {
  const [, action, name, map, ...rest] = positional
  const call = (method, path, body) =>
    callApi({ url: flags.url, auth: flags.auth, method, path, body })
  if (action === 'add') {
    requireOnlyFlags(flags, ['auth', 'url', 'segments'], 'app add')
    if (!name || !map || rest.length) throw new Error(USAGE)
    const segments = flags.segments
      ? flags.segments.split(',').map((segment) => segment.trim()).filter(Boolean)
      : []
    const body = isUrl(map) ? { mapUrl: map, segments } : {
      map: await Deno.readTextFile(map).catch((error) => {
        throw new Error(`cannot read the app map ${map}: ${error.message}`)
      }),
      segments,
    }
    const result = await call('PUT', `/apps/${encodeURIComponent(name)}`, body)
    logger.plain(`Registered ${summary(result)}`)
    logger.plain(`Send records to /collect/${result.name}`)
    return
  }
  requireOnlyFlags(flags, ['auth', 'url', 'json'], `app ${action ?? ''}`.trim())
  if (action === 'ls') {
    if (name) throw new Error(USAGE)
    const { apps } = await call('GET', '/apps')
    if (flags.json) return console.log(JSON.stringify(apps, null, 2))
    if (!apps.length) return logger.plain('No app is registered.')
    logger.plain(formatTable(
      ['name', 'pages', 'segments', 'accepted', 'rejected', 'map', 'mapError'],
      apps.map((entry) => ({
        ...entry,
        segments: entry.segments.join(',') || null,
        map: entry.mapUrl ?? 'uploaded',
      })),
    ))
    return
  }
  if (!name || map) throw new Error(USAGE)
  const path = `/apps/${encodeURIComponent(name)}`
  if (action === 'show') return console.log(JSON.stringify(await call('GET', path), null, 2))
  if (action === 'refresh') {
    const result = await call('POST', `${path}/refresh`)
    if (result.mapError) throw new Error(`the map of ${name} could not be read: ${result.mapError}`)
    return logger.plain(`Refreshed ${summary(result)}`)
  }
  if (action === 'rm') {
    await call('DELETE', path)
    return logger.plain(`Removed ${name}. Its stored data stays until the retention removes it.`)
  }
  throw new Error(USAGE)
}
