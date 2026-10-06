import { parseArgs } from './src/args.js'
import { app } from './src/commands/app.js'
import { backup } from './src/commands/backup.js'
import { consoleCommand } from './src/commands/console.js'
import { help } from './src/commands/help.js'
import { key } from './src/commands/key.js'
import { query } from './src/commands/query.js'
import { restore } from './src/commands/restore.js'
import { server } from './src/commands/server.js'
import { add, ls, rm, use } from './src/commands/servers.js'
import { skill } from './src/commands/skill.js'
import { status } from './src/commands/status.js'
import { token } from './src/commands/token.js'
import { update } from './src/commands/update.js'
import { version } from './src/commands/version.js'
import { logger } from './src/logger.js'

const COMMANDS = {
  add,
  app,
  backup,
  console: consoleCommand,
  help,
  key,
  ls,
  query,
  restore,
  rm,
  server,
  skill,
  status,
  token,
  update,
  use,
  version,
}

try {
  const parsed = parseArgs(Deno.args)
  logger.setDebug(Boolean(parsed.flags.debug))
  const [name] = parsed.positional
  if (parsed.flags.version) version()
  else if (parsed.flags.help || name === undefined) help()
  else if (Object.hasOwn(COMMANDS, name)) await COMMANDS[name](parsed)
  else throw new Error(`unknown command "${name}" - run imp-aly help`)
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error))
  logger.debug(error)
  Deno.exit(1)
}
