import {
  clientAddress,
  clientKeys,
  createRateLimiter,
  NETWORK_SCALE,
  parseTrustedProxies,
} from '../src/rate-limit.js'
import { assertEquals } from './assert.js'

const one = (key) => [{ key, scale: 1 }]

Deno.test('blocks an address over a window and frees it later', () => {
  let time = 1_200_000
  const limiter = createRateLimiter({
    limits: [{ name: '5s', ms: 5_000, limit: 10 }, { name: '1m', ms: 60_000, limit: 25 }],
    now: () => time,
  })
  assertEquals(limiter.take(one('a'), 10), null)
  assertEquals(limiter.take(one('a'), 1)?.name, '5s')
  assertEquals(limiter.take(one('b'), 1), null)
  time += 10_000
  assertEquals(limiter.take(one('a'), 10), null)
  time += 10_000
  assertEquals(limiter.take(one('a'), 5), null)
  assertEquals(limiter.take(one('a'), 1)?.name, '1m')
  time += 120_000
  assertEquals(limiter.take(one('a'), 1), null)
})

Deno.test('the previous window counts with its weight', () => {
  let time = 0
  const limiter = createRateLimiter({
    limits: [{ name: '5s', ms: 5_000, limit: 10 }],
    now: () => time,
  })
  limiter.take(one('a'), 9)
  time = 5_000
  limiter.take(one('a'), 1)
  assertEquals(limiter.take(one('a'), 1)?.name, '5s')
  time = 9_000
  assertEquals(limiter.take(one('a'), 1), null)
})

Deno.test('a refused amount is not counted', () => {
  const limiter = createRateLimiter({ limits: [{ name: '5s', ms: 5_000, limit: 10 }] })
  assertEquals(limiter.take(one('a'), 6), null)
  assertEquals(limiter.take(one('a'), 5)?.name, '5s')
  assertEquals(limiter.take(one('a'), 4), null)
  assertEquals(limiter.take(one('a'), 1)?.name, '5s')
})

Deno.test('keeps two generations of addresses and forgets the older one', () => {
  const limiter = createRateLimiter({
    limits: [{ name: '5s', ms: 5_000, limit: 1 }],
    maxClients: 4,
  })
  for (const key of ['a', 'b', 'c', 'd']) limiter.take(one(key), 1)
  assertEquals(limiter.size(), 4)
  assertEquals(limiter.take(one('a'), 1)?.name, '5s')
  assertEquals(limiter.size(), 3)
  assertEquals(limiter.take(one('b'), 1), null)
  limiter.take(one('e'), 1)
  assertEquals(limiter.size(), 3)
  assertEquals(limiter.take(one('c'), 1), null)
  assertEquals(limiter.take(one('a'), 1)?.name, '5s')
  assertEquals(limiter.take(one('e'), 1)?.name, '5s')
})

Deno.test('the addresses of one IPv6 /48 share a larger limit', () => {
  const limiter = createRateLimiter({ limits: [{ name: '5s', ms: 5_000, limit: 2 }] })
  for (let index = 0; index < NETWORK_SCALE; index++) {
    const keys = clientKeys(`2001:db8:1:${index.toString(16)}::1`)
    assertEquals(limiter.take(keys, 2), null)
    assertEquals(limiter.take(keys, 1)?.name, '5s')
  }
  assertEquals(limiter.take(clientKeys('2001:db8:1:ff::1'), 1)?.name, '5s')
  assertEquals(limiter.take(clientKeys('2001:db8:2:ff::1'), 1), null)
})

Deno.test('makes the keys of a client address', () => {
  assertEquals(clientKeys('203.0.113.5'), one('203.0.113.5'))
  assertEquals(clientKeys('::ffff:203.0.113.5'), one('203.0.113.5'))
  assertEquals(clientKeys('2001:db8:1:2:3:4:5:6'), [
    { key: '2001:db8:1:2::/64', scale: 1 },
    { key: '2001:db8:1::/48', scale: NETWORK_SCALE },
  ])
  assertEquals(clientKeys('2001:DB8:1:2::9')[0].key, '2001:db8:1:2::/64')
  assertEquals(clientKeys('2001:db8::1')[0].key, '2001:db8:0:0::/64')
  assertEquals(clientKeys('unknown'), one('unknown'))
  assertEquals(clientKeys('203.0.113.5:5678'), one('203.0.113.5'))
  assertEquals(clientKeys('[2001:db8:1:2::9]:443')[0].key, '2001:db8:1:2::/64')
})

Deno.test('a port, brackets or a mapped IPv4 in the proxy header give the same address', () => {
  const local = { remoteAddr: { hostname: '127.0.0.1' } }
  const options = {
    ipHeader: 'x-forwarded-for',
    trustedProxies: parseTrustedProxies(['127.0.0.0/8']),
  }
  const from = (value) =>
    clientAddress(
      new Request('http://x/', { headers: { 'x-forwarded-for': value } }),
      local,
      options,
    )
  for (
    const value of ['1.2.3.4:5678', '9.9.9.9, 1.2.3.4:1', '[::ffff:1.2.3.4]:80', '::ffff:1.2.3.4']
  ) {
    assertEquals(from(value), '1.2.3.4', value)
  }
  assertEquals(from('[2001:db8::1]:443'), from('2001:DB8::1'))
  assertEquals(from('unknown'), '127.0.0.1')
  assertEquals(from('1.2.3.4:abc'), '127.0.0.1')
  const limiter = createRateLimiter({ limits: [{ name: '5s', ms: 5_000, limit: 2 }] })
  assertEquals(limiter.take(clientKeys(from('1.2.3.4:1')), 1), null)
  assertEquals(limiter.take(clientKeys(from('1.2.3.4:2')), 1), null)
  assertEquals(limiter.take(clientKeys(from('1.2.3.4:3')), 1)?.name, '5s')
})

Deno.test('reads the client address from the header of a trusted proxy only', () => {
  const headers = { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }
  const request = new Request('http://x/', { headers })
  const local = { remoteAddr: { hostname: '127.0.0.1' } }
  const outside = { remoteAddr: { hostname: '198.51.100.7' } }
  const loopback = parseTrustedProxies(['127.0.0.0/8', '::1'])
  const options = { ipHeader: 'x-forwarded-for', trustedProxies: loopback }
  assertEquals(clientAddress(request, local), '127.0.0.1')
  assertEquals(clientAddress(request, local, options), '2.2.2.2')
  assertEquals(clientAddress(request, outside, options), '198.51.100.7')
  assertEquals(clientAddress(new Request('http://x/'), local, options), '127.0.0.1')
  const proxies = parseTrustedProxies(['198.51.100.0/24'])
  const fromProxy = { ipHeader: 'x-forwarded-for', trustedProxies: proxies }
  assertEquals(clientAddress(request, outside, fromProxy), '2.2.2.2')
  assertEquals(clientAddress(request, local, fromProxy), '127.0.0.1')
})
