import { consoleHosts, createConsoleHandler, startConsole } from '../src/console.js'
import { ApiError, eachServer, queryEach, requireAnswer } from '../src/multi-server.js'
import { serveUi } from '../src/static-files.js'
import { assert, assertEquals, assertRejects, temporaryDir } from './assert.js'

const writeUi = async () => {
  const uiDir = await temporaryDir()
  await Deno.mkdir(`${uiDir}/chunks`)
  await Deno.writeTextFile(`${uiDir}/index.html`, '<!DOCTYPE html><title>console</title>')
  await Deno.writeTextFile(`${uiDir}/chunks/main-1.js`, 'export {}')
  await Deno.writeTextFile(`${await temporaryDir()}/secret.txt`, 'secret')
  return uiDir
}

const answerOf = (records, appConfig = 'a') => ({
  days: ['2026-10-01'],
  summaryDays: 1,
  scanned: records,
  matched: records,
  skippedDays: [],
  groups: [{ by: ['page'], records, visits: records }],
  appConfig,
})

Deno.test('the console answers only on localhost, serves files only, and sets strict headers', async () => {
  const handler = createConsoleHandler({ uiDir: await writeUi(), hosts: () => consoleHosts(8010) })
  const request = (path, headers = {}, method = 'GET') =>
    handler(
      new Request(`http://localhost:8010${path}`, {
        method,
        headers: { host: 'localhost:8010', ...headers },
      }),
    )

  const page = await request('/servers')
  assertEquals(page.status, 200)
  assertEquals(await page.text(), '<!DOCTYPE html><title>console</title>')
  const policy = page.headers.get('content-security-policy')
  assert(policy.includes("script-src 'self'"))
  assert(policy.includes("connect-src 'self' https: http:"))
  assertEquals(page.headers.get('x-frame-options'), 'DENY')
  assertEquals((await request('/', { host: 'evil.example:8010' })).status, 403)
  assertEquals((await request('/', { host: '127.0.0.1:8010' })).status, 200)
  assertEquals((await request('/', {}, 'POST')).status, 405)
})

Deno.test('the page adds up the answers of several servers like the CLI, and names a failed server', async () => {
  const targets = ['one', 'two', 'down'].map((label) => ({ label }))
  const call = (target, request) => {
    assertEquals([request.method, request.path], ['POST', '/query'])
    if (target.label === 'down') return Promise.reject(new Error('cannot reach down'))
    return Promise.resolve(answerOf(target.label === 'one' ? 2 : 3, target.label))
  }
  const { result, warnings } = await queryEach(
    targets,
    { app: 'myapp', from: '2026-10-01', groupBy: ['page'], measures: ['records', 'visits'] },
    call,
  )
  assertEquals(result.rows, [{ page: 'page', records: 5, visits: 5 }])
  assertEquals(result.failedServers, [{ server: 'down', reason: 'cannot reach down' }])
  assertEquals(warnings, [
    'the app myapp has different builds or different segments on the servers',
  ])

  const each = await eachServer(targets, (target) => {
    if (target.label === 'down') throw new Error('no answer')
    return target.label
  })
  assertEquals(requireAnswer(each).results.map(({ result }) => result), ['one', 'two'])
  const none = await eachServer([{ label: 'a' }, { label: 'b' }], () => {
    throw new Error('no answer')
  })
  let error
  try {
    requireAnswer(none)
  } catch (caught) {
    error = caught
  }
  assert(error instanceof ApiError && error.status === 502)
})

Deno.test('the page files are served with a fallback for routes and never outside the folder', async () => {
  const uiDir = await writeUi()
  const index = await serveUi(uiDir, '/overview')
  assertEquals(await index.text(), '<!DOCTYPE html><title>console</title>')
  assertEquals(index.headers.get('cache-control'), 'no-cache')
  const chunk = await serveUi(uiDir, '/chunks/main-1.js')
  assertEquals(chunk.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert(chunk.headers.get('cache-control').includes('immutable'))
  await chunk.body?.cancel()
  for (const path of ['/chunks/main-2.js', '/missing.js', '/../secret.txt', '/%2e%2e/secret.txt']) {
    const response = await serveUi(uiDir, path)
    assertEquals(response.status, 404, path)
    await response.body?.cancel()
  }
})

Deno.test('the console does not start without its page, or on a port in use', async () => {
  const empty = await temporaryDir()
  await assertRejects(() => startConsole({ port: 0, uiDir: empty }), /console page is missing/)
  const uiDir = await writeUi()
  const first = await startConsole({ port: 0, uiDir })
  try {
    await assertRejects(() => startConsole({ port: first.port, uiDir }), /is in use/)
  } finally {
    await first.shutdown()
  }
})
