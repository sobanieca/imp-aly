import { requireOnlyFlags } from '../args.js'
import { logger } from '../logger.js'
import { addServer, loadServers, removeServer, serversPath, useServer } from '../servers.js'
import { formatTable } from '../table.js'

const keyLabel = (auth) => {
  if (!auth) return 'default key file'
  return auth.startsWith('/') ? auth : 'saved key'
}

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

export const ls = ({ positional, flags }) => {
  requireOnlyFlags(flags, ['json'], 'ls')
  if (positional.length > 1) throw new Error('use: imp-aly ls [--json]')
  const store = loadServers()
  const servers = store.servers.map((entry) => ({ ...entry, auth: keyLabel(entry.auth) }))
  if (flags.json) return console.log(JSON.stringify({ ...store, servers }, null, 2))
  if (!servers.length) {
    return logger.plain('No server is saved. Add one with: imp-aly add <name> <url>')
  }
  logger.plain(formatTable(
    ['default', 'name', 'url', 'key'],
    servers.map((entry) => ({
      ...entry,
      default: entry.name === store.default ? '*' : '',
      key: entry.auth,
    })),
  ))
}

const readName = ({ positional, flags }, command) => {
  requireOnlyFlags(flags, [], command)
  const [, name, ...rest] = positional
  if (!name || rest.length) throw new Error(`use: imp-aly ${command} <name>`)
  return name
}

export const use = (parsed) => {
  const found = useServer(readName(parsed, 'use'))
  logger.plain(`"${found.name}" (${found.url}) is the default server now`)
}

export const rm = (parsed) => {
  const removed = removeServer(readName(parsed, 'rm'))
  const next = loadServers().default
  logger.plain(`Removed server "${removed.name}" (${removed.url})`)
  if (next) logger.plain(`The default server is "${next}"`)
}
