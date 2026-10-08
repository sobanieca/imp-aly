import { requireOnlyFlags } from '../args.js'
import { logger } from '../logger.js'
import {
  addGroup,
  addServer,
  keyLabel,
  loadServers,
  removeSaved,
  serversPath,
  useSaved,
} from '../servers.js'
import { formatTable } from '../table.js'

export const add = ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth'], 'add')
  const [, name, url, ...rest] = positional
  if (!name || !url || rest.length) {
    throw new Error('use: imp-aly add <name> <url> [-a <key or file>]')
  }
  const saved = addServer({ name, url, auth: flags.auth })
  logger.plain(`Saved server "${saved.name}": ${saved.url}, key: ${keyLabel(saved.auth)}`)
  logger.plain(`It is the default server now. Saved in ${serversPath()}`)
}

export const group = ({ positional, flags }) => {
  requireOnlyFlags(flags, [], 'group')
  const [, name, servers, ...rest] = positional
  if (!name || !servers || rest.length) throw new Error('use: imp-aly group <name> <a,b,c>')
  const saved = addGroup({ name, servers })
  logger.plain(`Saved group "${saved.name}": ${saved.servers.join(', ')}`)
  if (loadServers().default !== saved.name) {
    logger.plain(`Make it the default with: imp-aly use ${saved.name}`)
  }
}

export const ls = ({ positional, flags }) => {
  requireOnlyFlags(flags, ['json'], 'ls')
  if (positional.length > 1) throw new Error('use: imp-aly ls [--json]')
  const store = loadServers()
  const servers = store.servers.map((entry) => ({ ...entry, auth: keyLabel(entry.auth) }))
  if (flags.json) return console.log(JSON.stringify({ ...store, servers }, null, 2))
  if (!servers.length) {
    return logger.plain('No server is saved. Add one with: imp-aly add <name> <url>')
  }
  const mark = (name) => (name === store.default ? '*' : '')
  logger.plain(formatTable(
    ['default', 'name', 'url', 'key'],
    servers.map((entry) => ({ ...entry, default: mark(entry.name), key: entry.auth })),
  ))
  if (!store.groups.length) return
  logger.plain('')
  logger.plain(formatTable(
    ['default', 'group', 'servers'],
    store.groups.map((entry) => ({
      default: mark(entry.name),
      group: entry.name,
      servers: entry.servers.join(','),
    })),
  ))
}

const readName = ({ positional, flags }, command) => {
  requireOnlyFlags(flags, [], command)
  const [, name, ...rest] = positional
  if (!name || rest.length) throw new Error(`use: imp-aly ${command} <name>`)
  return name
}

const describe = ({ server, group }) =>
  server
    ? `server "${server.name}" (${server.url})`
    : `group "${group.name}" (${group.servers.join(', ')})`

export const use = (parsed) => {
  const found = useSaved(readName(parsed, 'use'))
  logger.plain(`The ${describe(found)} is the default now`)
}

export const rm = (parsed) => {
  const removed = removeSaved(readName(parsed, 'rm'))
  const next = loadServers().default
  logger.plain(`Removed ${describe(removed)}`)
  if (next) logger.plain(`The default is "${next}"`)
}
