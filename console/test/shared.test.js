import { expect, test } from 'imp/test'
import { addDays, addMonths, dayCount, isDay, weekOf } from '../src/shared/days.js'
import { eachServer, queryEach, requireAnswer } from '../src/shared/multi-server.js'
import { finalizeQuery, parseQuery } from '../src/shared/query-core.js'
import { sha256Hex } from '../src/shared/sha256.js'
import { createToken, EMPTY_BODY_HASH, importSigningKey } from '../src/shared/token.js'
import cases from './merge-cases.json' with { type: 'json' }

const NOW = Date.parse('2026-10-10T12:00:00Z')

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

test('days count in UTC, a month back keeps the day, and a week starts on Monday', () => {
  expect(isDay('2024-02-29')).toEqual(true)
  expect(isDay('2026-02-29')).toEqual(false)
  expect(addDays('2026-12-31', 1)).toEqual('2027-01-01')
  expect(dayCount('2026-09-01', '2026-09-30')).toEqual(30)
  expect(addMonths('2026-03-31', -1)).toEqual('2026-02-28')
  expect(addMonths('2024-03-30', -1)).toEqual('2024-02-29')
  expect(weekOf('2026-10-11')).toEqual('2026-10-05')
  expect(weekOf('2026-10-05')).toEqual('2026-10-05')
})

test('the hash matches the platform for any length', async () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const bytes = new Uint8Array(length).map((_, index) => (index * 31) % 256)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    expect(sha256Hex(bytes)).toEqual(hex(digest))
  }
  expect(EMPTY_BODY_HASH).toEqual(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
})

test('a token signs the time, the nonce, the method, the path and the body hash', async () => {
  const key = 'test-key-0123456789'
  const token = await createToken(key, { method: 'get', path: '/backup?by=week' })
  const [timestamp, nonce, bodyHash, mac] = token.split('.')
  expect(Math.abs(Number(timestamp) - Date.now()) < 60_000).toEqual(true)
  expect(nonce).toMatch(/^[0-9a-f]{24}$/)
  expect(bodyHash).toEqual(EMPTY_BODY_HASH)
  const text = [timestamp, nonce, 'GET', '/backup?by=week', bodyHash].join('\n')
  const cryptoKey = await importSigningKey(key)
  const expected = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(text))
  expect(mac).toEqual(hex(new Uint8Array(expected)))
  const locked = await importSigningKey(key)
  const other = await createToken(locked, { method: 'GET', path: '/status' })
  expect(other.split('.').length).toEqual(4)
})

test('queries are validated like on the server', () => {
  expect(parseQuery({ app: 'myapp' }, NOW).from).toEqual('2026-10-10')
  expect(parseQuery({ app: 'myapp', from: '2026-09-01' }, NOW).to).toEqual('2026-09-01')
  for (
    const input of [
      [],
      { app: 'Bad' },
      { app: 'myapp', extra: 1 },
      { app: 'myapp', from: '2026-10-02', to: '2026-10-01' },
      { app: 'myapp', where: { at: '1' } },
      { app: 'myapp', groupBy: ['day', 'week'] },
      { app: 'myapp', measures: ['nope'] },
      { app: 'myapp', limit: 0 },
    ]
  ) {
    expect(() => parseQuery(input, NOW)).toThrow()
  }
})

test('the answers of the servers add up like in the CLI', () => {
  for (const { query, answers, result } of cases) {
    expect(finalizeQuery(parseQuery(query, NOW), answers)).toEqual(result)
  }
})

test('the page adds up the answers of several servers and names a failed server', async () => {
  const answerOf = (records, appConfig) => ({
    days: ['2026-10-01'],
    summaryDays: 1,
    scanned: records,
    matched: records,
    skippedDays: [],
    groups: [{ by: ['page'], records, visits: records }],
    appConfig,
  })
  const targets = ['one', 'two', 'down', 'proxy'].map((label) => ({ label }))
  const call = (target) => {
    if (target.label === 'down') return Promise.reject(new Error('cannot reach down'))
    if (target.label === 'proxy') return Promise.resolve('<html>login</html>')
    return Promise.resolve(answerOf(target.label === 'one' ? 2 : 3, target.label))
  }
  const { result, warnings } = await queryEach(
    targets,
    { app: 'myapp', from: '2026-10-01', groupBy: ['page'], measures: ['records', 'visits'] },
    call,
  )
  expect(result.rows).toEqual([{ page: 'page', records: 5, visits: 5 }])
  expect(result.failedServers).toEqual([
    { server: 'down', reason: 'cannot reach down' },
    { server: 'proxy', reason: 'proxy sent a reply that is not a query answer' },
  ])
  expect(warnings).toEqual([
    'the app myapp has different builds or different segments on the servers',
  ])
  const each = await eachServer(targets.slice(0, 3), (target) => {
    if (target.label === 'down') throw new Error('no answer')
    return target.label
  })
  expect(requireAnswer(each).results.map(({ result }) => result)).toEqual(['one', 'two'])
  const none = await eachServer([{ label: 'a' }, { label: 'b' }], () => {
    throw new Error('no answer')
  })
  expect(() => requireAnswer(none)).toThrow(/no server answered/)
})
