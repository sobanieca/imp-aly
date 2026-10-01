import { parseArgs } from './src/args.js'
import { app } from './src/commands/app.js'
import { help } from './src/commands/help.js'
import { query } from './src/commands/query.js'
import { serve } from './src/commands/serve.js'
import { status } from './src/commands/status.js'
import { token } from './src/commands/token.js'
import { version } from './src/commands/version.js'
import { logger } from './src/logger.js'

const COMMANDS = { app, help, query, status, token, version }

try {
  const parsed = parseArgs(Deno.args)
  logger.setDebug(Boolean(parsed.flags.debug))
  const [name] = parsed.positional
  if (parsed.flags.help) help()
  else if (parsed.flags.version) version()
  else if (name && Object.hasOwn(COMMANDS, name)) await COMMANDS[name](parsed)
  else await serve(parsed)
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error))
  logger.debug(error)
  Deno.exit(1)
}
