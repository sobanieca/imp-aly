import { parsePort, requireOnlyFlags } from '../args.js'
import { startConsole } from '../console.js'
import { logger } from '../logger.js'
import { version } from '../version.js'

export const consoleCommand = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['port'], 'console')
  if (positional.length > 1) throw new Error('use: imp-aly console [--port <port>]')
  const port = flags.port === undefined ? undefined : parsePort(flags.port)
  const running = await startConsole({ port })
  logger.plain(`imp-aly ${version} - console`)
  logger.plain('')
  logger.plain(`To open the console, go to ${running.url}`)
  logger.plain('')
  logger.plain('The console uses the saved servers and their keys. Press Ctrl+C to stop it.')
  const stop = async () => {
    await running.shutdown()
    Deno.exit(0)
  }
  Deno.addSignalListener('SIGINT', stop)
  Deno.addSignalListener('SIGTERM', stop)
  await new Promise(() => {})
}
