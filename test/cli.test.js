import { parseArgs, requireOnlyFlags } from '../src/args.js'
import { app } from '../src/commands/app.js'
import { readServeOptions, serviceArgs } from '../src/commands/server.js'
import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
import { quote, serviceProblems, unitFile } from '../src/service.js'
import { assert, assertEquals, assertRejects, assertThrows, temporaryDir } from './assert.js'

Deno.test('arguments parse into positionals and flags', () => {
  assertEquals(parseArgs(['--port', '2980', '-a', 'key', '--foreground']), {
    positional: [],
    flags: { port: '2980', auth: 'key', foreground: true },
  })
  assertEquals(
    parseArgs(['app', 'add', 'x', 'map.txt', '--segments=plan,role', '--limit-5s', '9']),
    {
      positional: ['app', 'add', 'x', 'map.txt'],
      flags: { segments: 'plan,role', limit5s: '9' },
    },
  )
  assertEquals(parseArgs(['query', '{}', '-s', 'eu']), {
    positional: ['query', '{}'],
    flags: { server: 'eu' },
  })
  assertThrows(() => parseArgs(['--nope']), /unknown option --nope/)
  assertThrows(() => parseArgs(['-x']), /unknown option -x/)
  assertThrows(() => parseArgs(['--port']), /needs a value/)
  assertThrows(() => parseArgs(['--port', '--foreground']), /needs a value/)
  assertThrows(() => parseArgs(['--foreground=yes']), /takes no value/)
  assertThrows(() => requireOnlyFlags({ limit5s: '1' }, ['port'], 'token'), /--limit-5s/)
})

Deno.test('server options are validated and turn into service arguments', () => {
  const options = readServeOptions({
    port: '2980',
    data: '/srv/analytics',
    ipHeader: 'X-Forwarded-For',
    trustedProxy: '10.0.0.0/8, ::1',
    maxRequests: '256',
    allowOrigin: 'https://myapp.example, http://localhost:5173',
    minFree: '5GB',
    limit1h: '500',
  })
  assertEquals(options.ipHeader, 'x-forwarded-for')
  assertEquals(options.limits.map((window) => window.limit), [200, 1500, 500, 200000])
  assertEquals(serviceArgs(options), [
    'server',
    '--port',
    '2980',
    '--admin-port',
    '2981',
    '--data',
    '/srv/analytics',
    '--ip-header',
    'x-forwarded-for',
    '--trusted-proxy',
    '10.0.0.0/8,::1',
    '--max-requests',
    '256',
    '--allow-origin',
    'https://myapp.example,http://localhost:5173',
    '--min-free',
    '5GB',
    '--limit-1h',
    '500',
  ])
  assertEquals(readServeOptions({}).dataDir, null)
  assertEquals(readServeOptions({ ipHeader: 'x-real-ip' }).trustedProxies, ['127.0.0.0/8', '::1'])
  assertEquals(serviceArgs(readServeOptions({ ipHeader: 'x-real-ip', data: '/d' })).length, 9)
  const admin = readServeOptions({ adminPort: '9000', adminBind: '127.0.0.1', data: '/d' })
  assertEquals(serviceArgs(admin).slice(3, 5), ['--admin-port', '9000'])
  assertEquals(serviceArgs(admin).slice(-2), ['--admin-bind', '127.0.0.1'])
  assertThrows(() => readServeOptions({ port: '2981' }), /must be different/)
  assertThrows(() => readServeOptions({ trustedProxy: '::1' }), /only with --ip-header/)
  assertThrows(
    () => readServeOptions({ ipHeader: 'x-real-ip', trustedProxy: '10.0.0.0/40' }),
    /prefix length/,
  )
  assertThrows(() => readServeOptions({ maxRequests: '0' }), /above 0/)
  assertThrows(() => readServeOptions({ port: '99999' }), /not a port/)
  assertThrows(() => readServeOptions({ tlsCert: 'a.pem' }), /go together/)
  assertThrows(() => readServeOptions({ ipHeader: 'bad header' }), /not a header/)
  assertEquals(readServeOptions({}).allowOrigins, null)
  assertThrows(() => readServeOptions({ allowOrigin: 'https://myapp.example/' }), /not an origin/)
  assertThrows(() => readServeOptions({ allowOrigin: 'myapp.example' }), /not an origin/)
  assertThrows(() => readServeOptions({ allowOrigin: ',' }), /at least one origin/)
  assertThrows(() => readServeOptions({ limit5s: '0' }), /above 0/)
  assertThrows(() => readServeOptions({ minFree: 'all' }), /not a size/)
})

Deno.test('the unit file runs the server as a restricted user', () => {
  const lines = (unit) => unit.split('\n')
  const unit = lines(unitFile({
    args: ['--port', '2980', '--data', '/srv/my data'],
    dataDir: '/srv/my data',
    ports: [2980, 2981],
    keyPath: '/root/.secret/imp-aly-key',
  }))
  assert(unit.some((line) => line.endsWith('--port 2980 --data "/srv/my data"')))
  for (
    const line of [
      'User=imp-aly',
      'Group=imp-aly',
      'Environment=IMP_ALY_SERVICE=1',
      'Restart=always',
      'LoadCredential=key:/root/.secret/imp-aly-key',
      'ReadWritePaths="/srv/my data"',
      'ProtectSystem=strict',
      'ProtectHome=true',
      'NoNewPrivileges=true',
      'CapabilityBoundingSet=',
      'AmbientCapabilities=',
      'WantedBy=multi-user.target',
    ]
  ) {
    assert(unit.includes(line), line)
  }
  assert(!unit.some((line) => line.startsWith('LoadCredential=tls')))
  assert(!unit.some((line) => line.startsWith('Environment=HOME')))

  const tls = lines(unitFile({
    args: ['--port', '443'],
    dataDir: '/home/owner/imp-aly',
    ports: [443, 2981],
    keyPath: '/root/.secret/imp-aly-key',
    tlsCert: '/etc/letsencrypt/live/a.example/fullchain.pem',
    tlsKey: '/etc/letsencrypt/live/a.example/privkey.pem',
  }))
  for (
    const line of [
      'LoadCredential=tls-cert:/etc/letsencrypt/live/a.example/fullchain.pem',
      'LoadCredential=tls-key:/etc/letsencrypt/live/a.example/privkey.pem',
      'ProtectHome=read-only',
      'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
      'AmbientCapabilities=CAP_NET_BIND_SERVICE',
    ]
  ) {
    assert(tls.includes(line), line)
  }
})

Deno.test('the service refuses a data folder in /root and paths it cannot load', () => {
  const problems = serviceProblems({
    dataDir: '/root/.imp-aly',
    keyPath: '/root/my key',
    tlsCert: null,
    tlsKey: null,
  })
  assert(problems.some((problem) => problem.includes('outside /root')))
  assert(problems.some((problem) => problem.includes('cannot load /root/my key')))
  assertEquals(
    serviceProblems({ dataDir: '/var/lib/imp-aly', keyPath: '/root/.secret/imp-aly-key' })
      .filter((problem) => !problem.includes('/usr/local/bin')),
    [],
  )
})

Deno.test('unit arguments escape systemd specifiers and variables', () => {
  assertEquals(quote('15%'), '15%%')
  assertEquals(quote('/srv/$HOME'), '/srv/$$HOME')
  assertEquals(quote('a b"c'), '"a b\\"c"')
})

Deno.test('app add uploads the file of a build folder', async () => {
  logger.setQuiet(true)
  const key = 'cli-test-key-0123456789'
  const dataDir = await temporaryDir()
  const dist = await temporaryDir()
  const server = await startServer({
    port: 0,
    adminPort: 0,
    hostname: '127.0.0.1',
    dataDir,
    key,
    minFree: null,
    quiet: true,
  })
  const flags = { url: `http://127.0.0.1:${server.adminPort}`, auth: key }
  const add = (source) => app({ positional: ['app', 'add', 'myapp', source], flags })
  try {
    await assertRejects(() => add(dist), /cannot read .*app-analytics.json/)
    await Deno.writeTextFile(
      `${dist}/app-analytics.json`,
      JSON.stringify({ pages: ['/', '/invoices/:id'], zones: ['myapp.send'], outcomes: [] }),
    )
    await assertRejects(() => add(`${dist}/app-analytics.json`), /is not a folder/)
    await add(dist)
    const listed = []
    const original = console.log
    console.log = (text) => listed.push(text)
    try {
      await app({ positional: ['app', 'show', 'myapp'], flags })
    } finally {
      console.log = original
    }
    const shown = JSON.parse(listed[0])
    assertEquals([shown.appUrl, shown.pages, shown.zones, shown.outcomes], [
      null,
      ['/', '/invoices/:id'],
      ['myapp.send'],
      [],
    ])
    await assertRejects(
      () => app({ positional: ['app', 'refresh', 'myapp'], flags }),
      /uploaded build and no appUrl/,
    )
  } finally {
    await server.shutdown()
    await Deno.remove(dataDir, { recursive: true })
    await Deno.remove(dist, { recursive: true })
  }
})
