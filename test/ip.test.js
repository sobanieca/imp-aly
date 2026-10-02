import { inNetwork, parseIp, parseNetwork } from '../src/ip.js'
import { assertEquals, assertThrows } from './assert.js'

Deno.test('parses IPv4 and IPv6 addresses', () => {
  assertEquals(parseIp('203.0.113.5'), { version: 4, parts: [203, 0, 113, 5] })
  assertEquals(parseIp('::ffff:203.0.113.5'), { version: 4, parts: [203, 0, 113, 5] })
  assertEquals(parseIp('::1').parts, [0, 0, 0, 0, 0, 0, 0, 1])
  assertEquals(parseIp('[2001:db8::1]').parts, [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
  assertEquals(parseIp('fe80::1%eth0').parts, [0xfe80, 0, 0, 0, 0, 0, 0, 1])
  assertEquals(parseIp('64:ff9b::192.0.2.1').parts, [0x64, 0xff9b, 0, 0, 0, 0, 0xc000, 0x201])
  assertEquals(parseIp('1:2:3:4:5:6:7:8').parts, [1, 2, 3, 4, 5, 6, 7, 8])
  for (const bad of ['', 'unknown', '256.0.0.1', '1.2.3', '1::2::3', '1:2:3:4:5:6:7:8:9', 'g::1']) {
    assertEquals(parseIp(bad), null, bad)
  }
  assertEquals(parseIp('1:2:3:4:5:6:7::8'), null)
})

Deno.test('matches addresses to networks', () => {
  const ten = parseNetwork('10.0.0.0/8')
  assertEquals(inNetwork(parseIp('10.200.1.2'), ten), true)
  assertEquals(inNetwork(parseIp('11.0.0.1'), ten), false)
  assertEquals(inNetwork(parseIp('::ffff:10.0.0.1'), ten), true)
  assertEquals(inNetwork(parseIp('::1'), ten), false)
  assertEquals(inNetwork(null, ten), false)
  const odd = parseNetwork('192.168.4.0/22')
  assertEquals(inNetwork(parseIp('192.168.7.255'), odd), true)
  assertEquals(inNetwork(parseIp('192.168.8.0'), odd), false)
  const six = parseNetwork('2001:db8:abcd::/36')
  assertEquals(inNetwork(parseIp('2001:db8:a000::1'), six), true)
  assertEquals(inNetwork(parseIp('2001:db8:b000::1'), six), false)
  assertEquals(inNetwork(parseIp('::1'), parseNetwork('::1')), true)
  assertEquals(inNetwork(parseIp('1.2.3.4'), parseNetwork('0.0.0.0/0')), true)
})

Deno.test('refuses a wrong network', () => {
  assertThrows(() => parseNetwork('10.0.0.0/33'), /prefix length/)
  assertThrows(() => parseNetwork('10.0.0.0/'), /prefix length/)
  assertThrows(() => parseNetwork('10.0.0.0/x'), /prefix length/)
  assertThrows(() => parseNetwork('localhost'), /not an address/)
  assertThrows(() => parseNetwork('10.0.0.0/8/8'), /not an address/)
})
