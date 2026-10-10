import { callServer } from '../src/api-client.js'
import { parseArgs, parsePort, requireOnlyFlags } from '../src/args.js'
import { startConsole } from '../src/console.js'
import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
import { openSource } from '../src/source.js'
import { applySegment } from '../src/storage.js'
import { version } from '../src/version.js'
import { createRandom, DEMO_APPS, seedLines, visitRecords } from './demo-data.js'
import { openDevData } from './dev-data.js'

const DAYS = 45

const VISIT_EVERY_MS = 3_000

const COUNTRY_HEADER = 'x-demo-country'

const DEMO_ADMIN_PORT = 44889

const DEMO_PORT = 44890

const RESET = '--reset'

const reset = Deno.args.includes(RESET)
const { flags } = parseArgs(Deno.args.filter((argument) => argument !== RESET))
requireOnlyFlags(flags, ['port'], 'start')
const port = flags.port === undefined ? undefined : parsePort(flags.port)

const { root, dataDir, key, fresh } = await openDevData(undefined, { reset })

const started = Date.now()
const random = createRandom(fresh ? 42 : started % 2147483648)
let seeded = 0
if (fresh) {
  const lines = seedLines({ random, now: Date.now(), days: DAYS })
  const source = await openSource(dataDir)
  await applySegment({ dataDir, source, segment: 1, text: `${lines.join('\n')}\n` })
  seeded = lines.length
}

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
if (fresh) {
  for (const app of DEMO_APPS) {
    await callServer({ label: 'demo', server: 'demo', url: adminUrl, auth: key }, {
      method: 'PUT',
      path: `/apps/${app.name}`,
      body: { build: JSON.stringify(app.build), segments: app.segments },
    })
  }
}

let sent = 0
const sendVisit = async () => {
  const app = DEMO_APPS[sent % DEMO_APPS.length]
  const { country, records } = visitRecords({
    app,
    random,
    visit: `live${started.toString(36)}-${sent++}`,
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
  throw error
}

console.log(`
imp-aly ${version} - demo

  Console:  ${running.url}
  Collect:  http://127.0.0.1:${server.port}/collect/<app>
  Apps:     ${DEMO_APPS.map(({ name }) => name).join(', ')}
  Data:     ${fresh ? `${seeded} new records in ${DAYS + 1} days` : 'the records of the last runs'},
            and a new visit every ${VISIT_EVERY_MS / 1000} seconds
  Folder:   ${root}

To add the demo server, open ${running.url}/servers, press "Add a server",
and type these values:

  Name:     demo
  URL:      ${adminUrl}
  Key:      ${key}

Press Ctrl+C to stop. The folder stays for the next start.
To start again with new sample data, run "deno task start --reset".
`)

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  await running.shutdown()
  await server.shutdown()
  Deno.exit(0)
}
Deno.addSignalListener('SIGINT', stop)
Deno.addSignalListener('SIGTERM', stop)
