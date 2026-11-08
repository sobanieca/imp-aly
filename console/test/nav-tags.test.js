import { beforeEach, expect, test } from 'imp/test'
import {
  failuresOf,
  isConnectionProblem,
  keepServers,
  markAnswered,
  noteOutcome,
  onHealthChange,
  resetHealth,
} from '../src/lib/health.js'
import { sectionTag, serversTag, shortName } from '../src/lib/nav-tags.js'

const catalogOf = (servers, apps = []) => ({
  servers: { servers: servers.map((name) => ({ name, url: `https://${name}.example` })) },
  apps,
  failedServers: [],
  error: null,
})

const failure = (status, message = 'it failed') => Object.assign(new Error(message), { status })

beforeEach(() => resetHealth())

test('a server name in the tag has at most 10 characters', () => {
  expect(shortName('eu-1')).toEqual('eu-1')
  expect(shortName('abcdefghij')).toEqual('abcdefghij')
  expect(shortName('eu-central-1')).toEqual('eu-cent...')
  expect(shortName('eu-central-1').length).toEqual(10)
})

test('the tag names the server of the chosen app, counts the others, and titles the full names', () => {
  const apps = [
    { name: 'shop', server: 'eu-central-1' },
    { name: 'shop', server: 'us-2' },
    { name: 'shop', server: 'ap-3' },
    { name: 'docs', server: 'us-2' },
  ]
  const catalog = catalogOf(['eu-central-1', 'us-2', 'ap-3'], apps)
  expect(serversTag({ catalog, app: 'shop' })).toEqual({
    text: 'eu-cent... +2',
    title: 'eu-central-1, us-2, ap-3',
  })
  expect(serversTag({ catalog, app: 'docs' })).toEqual({ text: 'us-2' })
  expect(serversTag({ catalog: catalogOf(['eu-central-1']), app: undefined })).toEqual({
    text: 'eu-cent...',
    title: 'eu-central-1',
  })
})

test('with no app, the tag names the saved servers, and with no server it shows nothing', () => {
  expect(serversTag({ catalog: catalogOf(['eu-1', 'us-2']), app: undefined })).toEqual({
    text: 'eu-1 +1',
    title: 'eu-1, us-2',
  })
  expect(serversTag({ catalog: catalogOf(['eu-1']), app: 'gone' })).toEqual({ text: 'eu-1' })
  expect(serversTag({ catalog: catalogOf([]), app: 'shop' })).toEqual(null)
  expect(serversTag({ catalog: undefined, app: 'shop' })).toEqual(null)
})

test('a failed saved server turns the tag red with the count of failed servers', () => {
  const catalog = catalogOf(['eu-1', 'us-2'], [{ name: 'shop', server: 'eu-1' }])
  const failures = [{ server: 'us-2', reason: 'cannot reach' }]
  expect(serversTag({ catalog, app: 'shop', failures })).toEqual({
    text: '1 failed',
    color: 'red',
    title: 'us-2',
  })
  const gone = [{ server: 'removed', reason: 'cannot reach' }]
  expect(serversTag({ catalog, app: 'shop', failures: gone })).toEqual({ text: 'eu-1' })
})

test('no answer, a timeout, a wrong key and a server error are connection problems', () => {
  expect(isConnectionProblem(new Error('cannot reach server "eu-1"'))).toEqual(true)
  expect(isConnectionProblem(failure(401))).toEqual(true)
  expect(isConnectionProblem(failure(403))).toEqual(true)
  expect(isConnectionProblem(failure(503))).toEqual(true)
  expect(isConnectionProblem(failure(400))).toEqual(false)
  expect(isConnectionProblem(failure(404))).toEqual(false)
  expect(isConnectionProblem(Object.assign(new Error('aborted'), { code: 'aborted' }))).toEqual(
    false,
  )
})

test('a failure stays until the server answers again, and a removed server is forgotten', () => {
  const changes = []
  const stop = new AbortController()
  onHealthChange(() => changes.push(failuresOf().length), stop.signal)
  noteOutcome('eu-1', failure(401, 'wrong key'))
  noteOutcome('us-2', new Error('cannot reach'))
  noteOutcome('ap-3', failure(400, 'bad query'))
  noteOutcome('eu-1', Object.assign(new Error('aborted'), { code: 'aborted' }))
  expect(failuresOf()).toEqual([
    { server: 'eu-1', reason: 'wrong key' },
    { server: 'us-2', reason: 'cannot reach' },
  ])
  markAnswered('eu-1')
  expect(failuresOf()).toEqual([{ server: 'us-2', reason: 'cannot reach' }])
  noteOutcome('us-2', failure(404, 'no such app'))
  expect(failuresOf()).toEqual([])
  noteOutcome('us-2', new Error('cannot reach'))
  keepServers(['eu-1'])
  expect(failuresOf()).toEqual([])
  stop.abort()
  noteOutcome('eu-1', new Error('cannot reach'))
  expect(changes).toEqual([1, 2, 1, 0, 1, 0])
})

test('the section tag shows only a failure', () => {
  const failed = { text: '1 failed', color: 'red', title: 'eu-1' }
  expect(sectionTag(failed)).toEqual(failed)
  expect(sectionTag({ text: 'eu-1' })).toEqual(null)
  expect(sectionTag(null)).toEqual(null)
})
