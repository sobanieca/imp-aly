import { callServer } from '../src/api-client.js'
import { parseArgs, parsePort, requireOnlyFlags } from '../src/args.js'
import { generateKey } from '../src/auth.js'
import { startConsole } from '../src/console.js'
import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
import { openSource } from '../src/source.js'
import { applySegment } from '../src/storage.js'
import { version } from '../src/version.js'
import { createRandom, DEMO_APPS, seedLines, visitRecords } from './demo-data.js'

const DAYS = 45

const VISIT_EVERY_MS = 3_000

const COUNTRY_HEADER = 'x-demo-country'

const DEMO_ADMIN_PORT = 44889

const DEMO_PORT = 44890

const { flags } = parseArgs(Deno.args)
requireOnlyFlags(flags, ['port'], 'start')
const port = flags.port === undefined ? undefined : parsePort(flags.port)

const root = await Deno.makeTempDir({ prefix: 'imp-aly-start-' })
const dataDir = `${root}/data`
await Deno.mkdir(dataDir)

const random = createRandom(42)
const lines = seedLines({ random, now: Date.now(), days: DAYS })
const source = await openSource(dataDir)
await applySegment({ dataDir, source, segment: 1, text: `${lines.join('\n')}\n` })

const key = generateKey()
const server = await startServer({
  port: DEMO_PORT,
  adminPort: DEMO_ADMIN_PORT,
  hostname: '127.0.0.1',
  dataDir,
  key,
  minFree: null,
  countryHeader: COUNTRY_HEADER,
  quiet: true,
})
const adminUrl = `http://127.0.0.1:${server.adminPort}`
const collectUrl = (app) => `http://127.0.0.1:${server.port}/collect/${app.name}`
for (const app of DEMO_APPS) {
  await callServer({ label: 'demo', server: 'demo', url: adminUrl, auth: key }, {
    method: 'PUT',
    path: `/apps/${app.name}`,
    body: { build: JSON.stringify(app.build), segments: app.segments },
  })
}

let sent = 0
const sendVisit = async () => {
  const app = DEMO_APPS[sent % DEMO_APPS.length]
  const { country, records } = visitRecords({
    app,
    random,
    visit: `live${sent++}`,
    start: Date.now(),
    recent: true,
  })
  try {
    const response = await fetch(collectUrl(app), {
      method: 'POST',
      headers: { [COUNTRY_HEADER]: country },
      body: JSON.stringify(records),
    })
    await response.body?.cancel()
  } catch (error) {
    logger.warn(`The demo visit was not sent: ${error.message}`)
  }
}
const timer = setInterval(sendVisit, VISIT_EVERY_MS)

let running
try {
  running = await startConsole({ port })
} catch (error) {
  clearInterval(timer)
  await server.shutdown()
  await Deno.remove(root, { recursive: true })
  throw error
}

console.log(`
imp-aly ${version} - demo

  Console:  ${running.url}
  Collect:  http://127.0.0.1:${server.port}/collect/<app>
  Apps:     ${DEMO_APPS.map(({ name }) => name).join(', ')}
  Data:     ${lines.length} records in ${DAYS + 1} days,
            and a new visit every ${VISIT_EVERY_MS / 1000} seconds
  Folder:   ${root}

To add the demo server, open ${running.url}/servers, press "Add a server",
and type these values:

  Name:     demo
  URL:      ${adminUrl}
  Key:      ${key}

Press Ctrl+C to stop. The demo removes its folder.
`)

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  await running.shutdown()
  await server.shutdown()
  await Deno.remove(root, { recursive: true })
  Deno.exit(0)
}
Deno.addSignalListener('SIGINT', stop)
Deno.addSignalListener('SIGTERM', stop)
