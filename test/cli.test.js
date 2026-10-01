import { parseArgs, requireOnlyFlags } from '../src/args.js'
import { readServeOptions, serviceArgs } from '../src/commands/serve.js'
import { quote, unitFile } from '../src/service.js'
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
    minFree: '5GB',
    limit1h: '500',
  })
  assertEquals(options.ipHeader, 'x-forwarded-for')
  assertEquals(options.limits.map((window) => window.limit), [200, 1500, 500, 200000])
  assertEquals(serviceArgs(options, '/root/.secret/key'), [
    '--port',
    '2980',
    '--data',
    '/srv/analytics',
    '--auth',
    '/root/.secret/key',
    '--ip-header',
    'x-forwarded-for',
    '--min-free',
    '5GB',
    '--limit-1h',
    '500',
  ])
  assertThrows(() => readServeOptions({ port: '99999' }), /not a port/)
  assertThrows(() => readServeOptions({ tlsCert: 'a.pem' }), /go together/)
  assertThrows(() => readServeOptions({ ipHeader: 'bad header' }), /not a header/)
  assertThrows(() => readServeOptions({ limit5s: '0' }), /above 0/)
  assertThrows(() => readServeOptions({ minFree: 'all' }), /not a size/)
})

Deno.test('the unit file runs the server as a service', () => {
  const unit = unitFile({ args: ['--port', '2980', '--data', '/srv/my data'], home: '/root' })
  assert(unit.includes('--port 2980 --data "/srv/my data"'))
  assert(unit.includes('Environment=IMP_ANALYTICS_SERVICE=1'))
  assert(unit.includes('Restart=always'))
  assert(unit.includes('WantedBy=multi-user.target'))
})

Deno.test('unit arguments escape systemd specifiers and variables', () => {
  assertEquals(quote('15%'), '15%%')
  assertEquals(quote('/srv/$HOME'), '/srv/$$HOME')
  assertEquals(quote('a b"c'), '"a b\\"c"')
})
