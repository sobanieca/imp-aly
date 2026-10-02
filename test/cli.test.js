import { parseArgs, requireOnlyFlags } from '../src/args.js'
import { readServeOptions, serviceArgs } from '../src/commands/server.js'
import { quote, serviceProblems, unitFile } from '../src/service.js'
import { assert, assertEquals, assertThrows } from './assert.js'

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
