import { callServer } from '../src/api-client.js'
import { parseArgs, parsePort, requireOnlyFlags } from '../src/args.js'
import { generateKey } from '../src/auth.js'
import { startConsole } from '../src/console.js'
import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
import { addServer } from '../src/servers.js'
import { applySegment } from '../src/storage.js'
import { version } from '../src/version.js'
import {
  createRandom,
  DEMO_APP,
  DEMO_MAP,
  DEMO_OUTCOMES,
  DEMO_SEGMENTS,
  DEMO_ZONES,
  seedLines,
  visitRecords,
} from './demo-data.js'

const DAYS = 45

const VISIT_EVERY_MS = 3_000

const COUNTRY_HEADER = 'x-demo-country'

const { flags } = parseArgs(Deno.args)
requireOnlyFlags(flags, ['port'], 'start')
const port = flags.port === undefined ? undefined : parsePort(flags.port)

const root = await Deno.makeTempDir({ prefix: 'imp-aly-start-' })
const dataDir = `${root}/data`
const serversFile = `${root}/config/imp-aly/servers.json`
await Deno.mkdir(dataDir)

const random = createRandom(42)
const lines = seedLines({ random, now: Date.now(), days: DAYS })
await applySegment({ dataDir, segment: 1, text: `${lines.join('\n')}\n` })

const key = generateKey()
const server = await startServer({
  port: 0,
  adminPort: 0,
  hostname: '127.0.0.1',
  dataDir,
  key,
  minFree: null,
  countryHeader: COUNTRY_HEADER,
  quiet: true,
})
const adminUrl = `http://127.0.0.1:${server.adminPort}`
const collectUrl = `http://127.0.0.1:${server.port}/collect/${DEMO_APP}`
addServer({ name: 'demo', url: adminUrl, auth: key }, serversFile)
await callServer({ label: 'demo', server: 'demo', url: adminUrl, auth: key }, {
  method: 'PUT',
  path: `/apps/${DEMO_APP}`,
  body: {
    build: JSON.stringify({ pages: DEMO_MAP, zones: DEMO_ZONES, outcomes: DEMO_OUTCOMES }),
    segments: DEMO_SEGMENTS,
  },
})

let sent = 0
const sendVisit = async () => {
  const { country, records } = visitRecords({
    random,
    visit: `live${sent++}`,
    start: Date.now(),
    recent: true,
  })
  try {
    const response = await fetch(collectUrl, {
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
  running = await startConsole({ port, serversFile })
} catch (error) {
  clearInterval(timer)
  await server.shutdown()
  await Deno.remove(root, { recursive: true })
  throw error
}

console.log(`
imp-aly ${version} - demo

  Server:   ${adminUrl} (admin), saved as "demo" in a temporary list
  Collect:  ${collectUrl}
  Data:     ${lines.length} records of the app "${DEMO_APP}" in ${DAYS + 1} days,
            and a new visit every ${VISIT_EVERY_MS / 1000} seconds
  Folder:   ${root}

To open the console, go to ${running.url}

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
