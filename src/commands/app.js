import { requireOnlyFlags } from '../args.js'
import { callApi, resolveTargets } from '../api-client.js'
import { logger } from '../logger.js'
import { formatTable } from '../table.js'

const USAGE = `use one of:
  imp-aly app add <name> <app-map url or file> [--segments plan,role]
  imp-aly app ls
  imp-aly app show <name>
  imp-aly app refresh <name>
  imp-aly app rm <name>`

const isUrl = (value) => /^https?:\/\//i.test(value)

const summary = (app) =>
  `${app.name}: ${app.pages} pages, segments ${
    app.segments.length ? app.segments.join(', ') : '-'
  }, map ${app.mapUrl ?? 'uploaded'}`

const onEachServer = async (targets, run) => {
  const results = []
  const failed = []
  for (const { label, ...target } of targets) {
    const call = (method, path, body) => callApi({ ...target, method, path, body })
    try {
      results.push({ server: label, result: await run(call) })
    } catch (error) {
      if (targets.length === 1) throw error
      logger.error(`${label}: ${error.message}`)
      failed.push(label)
    }
  }
  return {
    results,
    finish: () => {
      if (failed.length) {
        throw new Error(
          `the command failed on ${failed.length} of ${targets.length} servers: ${
            failed.join(', ')
          }`,
        )
      }
    },
  }
}

const readBody = async (map, segments) => {
  if (isUrl(map)) return { mapUrl: map, segments }
  const text = await Deno.readTextFile(map).catch((error) => {
    throw new Error(`cannot read the app map ${map}: ${error.message}`)
  })
  return { map: text, segments }
}

export const app = async ({ positional, flags }) => {
  const [, action, name, map, ...rest] = positional
  const targets = resolveTargets(flags)
  const many = targets.length > 1
  const prefix = (server) => (many ? `${server}: ` : '')
  if (action === 'add') {
    requireOnlyFlags(flags, ['auth', 'url', 'server', 'segments'], 'app add')
    if (!name || !map || rest.length) throw new Error(USAGE)
    const segments = flags.segments
      ? flags.segments.split(',').map((segment) => segment.trim()).filter(Boolean)
      : []
    const body = await readBody(map, segments)
    const { results, finish } = await onEachServer(
      targets,
      (call) => call('PUT', `/apps/${encodeURIComponent(name)}`, body),
    )
    for (const { server, result } of results) {
      logger.plain(`${prefix(server)}Registered ${summary(result)}`)
    }
    if (results.length) logger.plain(`Send records to /collect/${results[0].result.name}`)
    return finish()
  }
  requireOnlyFlags(flags, ['auth', 'url', 'server', 'json'], `app ${action ?? ''}`.trim())
  if (action === 'ls') {
    if (name) throw new Error(USAGE)
    const { results, finish } = await onEachServer(targets, (call) => call('GET', '/apps'))
    const apps = results.flatMap(({ server, result }) =>
      result.apps.map((entry) => (many ? { server, ...entry } : entry))
    )
    if (flags.json) console.log(JSON.stringify(apps, null, 2))
    else if (!apps.length) logger.plain('No app is registered.')
    else {
      const columns = ['name', 'pages', 'segments', 'accepted', 'rejected', 'map', 'mapError']
      logger.plain(formatTable(
        many ? ['server', ...columns] : columns,
        apps.map((entry) => ({
          ...entry,
          segments: entry.segments.join(',') || null,
          map: entry.mapUrl ?? 'uploaded',
        })),
      ))
    }
    return finish()
  }
  if (!name || map) throw new Error(USAGE)
  const path = `/apps/${encodeURIComponent(name)}`
  if (action === 'show') {
    const { results, finish } = await onEachServer(targets, (call) => call('GET', path))
    const shown = many
      ? results.map(({ server, result }) => ({ server, ...result }))
      : results[0].result
    console.log(JSON.stringify(shown, null, 2))
    return finish()
  }
  if (action === 'refresh') {
    const { results, finish } = await onEachServer(targets, async (call) => {
      const result = await call('POST', `${path}/refresh`)
      if (result.mapError) {
        throw new Error(`the map of ${name} could not be read: ${result.mapError}`)
      }
      return result
    })
    for (const { server, result } of results) {
      logger.plain(`${prefix(server)}Refreshed ${summary(result)}`)
    }
    return finish()
  }
  if (action === 'rm') {
    const { results, finish } = await onEachServer(targets, (call) => call('DELETE', path))
    for (const { server } of results) {
      logger.plain(
        `${prefix(server)}Removed ${name}. Its stored data stays until the retention removes it.`,
      )
    }
    return finish()
  }
  throw new Error(USAGE)
}
