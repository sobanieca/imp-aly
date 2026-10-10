import { CLIENT_SHARE, createInFlight, NETWORK_SHARE } from '../src/in-flight.js'
import { clientKeys } from '../src/rate-limit.js'
import { assert, assertEquals } from './assert.js'

Deno.test('one address holds only its share of the requests in progress', () => {
  const inFlight = createInFlight({ max: 1_024 })
  const one = clientKeys('203.0.113.5')
  const share = 1_024 / CLIENT_SHARE
  const leaves = Array.from({ length: share }, () => inFlight.enter(one))
  assert(leaves.every(Boolean))
  assertEquals(inFlight.enter(one), null)
  assertEquals(inFlight.count(), share)
  assert(inFlight.enter(clientKeys('203.0.113.6')))
  leaves[0]()
  leaves[0]()
  assertEquals(inFlight.count(), share)
  assert(inFlight.enter(one))
  assertEquals(inFlight.full(), false)
})

Deno.test('the networks of a /48 share a few times the share of one address', () => {
  const inFlight = createInFlight({ max: 64, perClient: 2 })
  let entered = 0
  for (let index = 0; index < 64; index++) {
    if (inFlight.enter(clientKeys(`2001:db8:1:${index.toString(16)}::1`))) entered++
  }
  assertEquals(entered, 2 * NETWORK_SHARE)
  assert(inFlight.enter(clientKeys('2001:db8:2::1')))
})

Deno.test('the cap of all requests stays the first check', () => {
  const inFlight = createInFlight({ max: 2, perClient: 2 })
  inFlight.enter(clientKeys('203.0.113.5'))
  assertEquals(inFlight.full(), false)
  inFlight.enter(clientKeys('203.0.113.6'))
  assertEquals(inFlight.full(), true)
})
