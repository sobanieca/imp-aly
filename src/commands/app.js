import { requireOnlyFlags } from '../args.js'
import { eachServer, resolveTargets } from '../api-client.js'
import { BUILD_FILE } from '../app-build.js'
import { logger } from '../logger.js'
import { join } from '../paths.js'
import { formatTable } from '../table.js'

const USAGE = `use one of:
  imp-aly app add <name> <app url or build folder> [--segments plan,role]
  imp-aly app ls
  imp-aly app show <name>
  imp-aly app refresh <name>
  imp-aly app rm <name>`

const isUrl = (value) => /^https?:\/\//i.test(value)

const summary = (app) =>
  `${app.name}: ${app.pages.length} pages, ${app.zones.length} zones, ${app.outcomes.length} outcomes, segments ${
    app.segments.length ? app.segments.join(', ') : '-'
  }, build ${app.appUrl ?? 'uploaded'}`

const onEachServer = async (targets, run) => {
  const { results, failed } = await eachServer(targets, run)
  for (const { server, reason } of failed) logger.error(`${server}: ${reason}`)
  return {
    results,
    finish: () => {
      if (failed.length) {
        throw new Error(
          `the command failed on ${failed.length} of ${targets.length} servers: ${
            failed.map(({ server }) => server).join(', ')
          }`,
        )
      }
    },
  }
}

const readBuildFolder = async (folder) => {
  const info = await Deno.stat(folder).catch((error) => {
    throw new Error(`cannot read the build folder ${folder}: ${error.message}`)
  })
  if (!info.isDirectory) {
    throw new Error(
      `${folder} is not a folder - give the build folder that holds ${BUILD_FILE}`,
    )
  }
  const path = join(folder, BUILD_FILE)
  const build = await Deno.readTextFile(path).catch((error) => {
    throw new Error(`cannot read ${path}: ${error.message}`)
  })
  return { build }
}

const readBody = async (source, segments) => {
  if (isUrl(source)) return { appUrl: source, segments }
  return { ...(await readBuildFolder(source)), segments }
}

export const app = async ({ positional, flags }) => {
  const [, action, name, source, ...rest] = positional
  const targets = resolveTargets(flags)
  const many = targets.length > 1
  const prefix = (server) => (many ? `${server}: ` : '')
  if (action === 'add') {
    requireOnlyFlags(flags, ['auth', 'url', 'server', 'segments'], 'app add')
    if (!name || !source || rest.length) throw new Error(USAGE)
    const segments = flags.segments
      ? flags.segments.split(',').map((segment) => segment.trim()).filter(Boolean)
      : []
    const body = await readBody(source, segments)
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
      const columns = [
        'name',
        'pages',
        'zones',
        'outcomes',
        'segments',
        'accepted',
        'rejected',
        'build',
        'buildError',
      ]
      logger.plain(formatTable(
        many ? ['server', ...columns] : columns,
        apps.map((entry) => ({
          ...entry,
          pages: entry.pages.length,
          zones: entry.zones.length,
          outcomes: entry.outcomes.length,
          segments: entry.segments.join(',') || null,
          build: entry.appUrl ?? 'uploaded',
        })),
      ))
    }
    return finish()
  }
  if (!name || source) throw new Error(USAGE)
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
      if (result.buildError) {
        throw new Error(`the build of ${name} could not be read: ${result.buildError}`)
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
