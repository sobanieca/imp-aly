import { expect, test } from 'imp/test'
import { agentCommand, agentKeyBody, DURATIONS, timeLeft } from '../src/lib/agent-keys.js'

const NOW = Date.UTC(2026, 10, 17, 12, 0)

test('the form offers 1, 4, 8 and 24 hours and sends the hours as a number', () => {
  expect(DURATIONS.map(({ value }) => value)).toEqual(['1', '4', '8', '24'])
  expect(agentKeyBody({ name: 'claude', hours: '8' })).toEqual({ name: 'claude', hours: 8 })
})

test('the command saves the server under the name of the key', () => {
  expect(agentCommand({ name: 'claude', url: 'https://a.example:4410', key: 'k1' })).toEqual(
    'imp-aly add claude https://a.example:4410 -a k1',
  )
})

test('the time left shows minutes and hours', () => {
  expect(timeLeft(new Date(NOW + 15 * 60_000).toISOString(), NOW)).toEqual('15 min left')
  expect(timeLeft(new Date(NOW + 90 * 60_000).toISOString(), NOW)).toEqual('1 h 30 min left')
  expect(timeLeft(new Date(NOW + 24 * 60 * 60_000).toISOString(), NOW)).toEqual('24 h left')
  expect(timeLeft(new Date(NOW - 1000).toISOString(), NOW)).toEqual('expired')
})
