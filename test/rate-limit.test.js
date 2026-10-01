import { clientAddress, clientKey, createRateLimiter } from '../src/rate-limit.js'
import { assertEquals } from './assert.js'

Deno.test('blocks an address over a window and frees it later', () => {
  let time = 1_000_000
  const limiter = createRateLimiter({
    limits: [{ name: '5s', ms: 5_000, limit: 10 }, { name: '1m', ms: 60_000, limit: 25 }],
    now: () => time,
  })
  assertEquals(limiter.exceeded('a'), null)
  limiter.add('a', 10)
  assertEquals(limiter.exceeded('a')?.name, '5s')
  assertEquals(limiter.exceeded('b'), null)
  time += 10_000
  assertEquals(limiter.exceeded('a'), null)
  limiter.add('a', 10)
  time += 10_000
  limiter.add('a', 5)
  assertEquals(limiter.exceeded('a')?.name, '1m')
  time += 120_000
  assertEquals(limiter.exceeded('a'), null)
})

Deno.test('the previous window counts with its weight', () => {
  let time = 0
  const limiter = createRateLimiter({
    limits: [{ name: '5s', ms: 5_000, limit: 10 }],
    now: () => time,
  })
  limiter.add('a', 9)
  time = 5_000
  limiter.add('a', 1)
  assertEquals(limiter.exceeded('a')?.name, '5s')
  time = 9_000
  assertEquals(limiter.exceeded('a'), null)
})

Deno.test('forgets the least recent address over the limit of clients', () => {
  const limiter = createRateLimiter({
    limits: [{ name: '5s', ms: 5_000, limit: 1 }],
    maxClients: 2,
  })
  limiter.add('a', 5)
  limiter.add('b', 5)
  limiter.add('c', 5)
  assertEquals(limiter.size(), 2)
  assertEquals(limiter.exceeded('a'), null)
  assertEquals(limiter.exceeded('c')?.name, '5s')
})

Deno.test('groups IPv6 addresses by /64', () => {
  assertEquals(clientKey('203.0.113.5'), '203.0.113.5')
  assertEquals(clientKey('::ffff:203.0.113.5'), '203.0.113.5')
  assertEquals(clientKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64')
  assertEquals(clientKey('2001:db8:1:2::9'), '2001:db8:1:2::/64')
  assertEquals(clientKey('2001:db8::1'), '2001:db8:0:0::/64')
  assertEquals(clientKey('::1'), '0:0:0:0::/64')
})

Deno.test('reads the client address from the configured header', () => {
  const info = { remoteAddr: { hostname: '10.0.0.1' } }
  const request = new Request('http://x/', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } })
  assertEquals(clientAddress(request, info, null), '10.0.0.1')
  assertEquals(clientAddress(request, info, 'x-forwarded-for'), '2.2.2.2')
  assertEquals(clientAddress(new Request('http://x/'), info, 'x-forwarded-for'), '10.0.0.1')
})
