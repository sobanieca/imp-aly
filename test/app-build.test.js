import {
  buildFileUrl,
  fetchBuild,
  folderUrl,
  MAX_FILE_BYTES,
  MAX_LIST_ENTRIES,
  parseBuild,
} from '../src/app-build.js'
import { assertEquals, assertRejects, assertThrows } from './assert.js'

const build = (lists) => JSON.stringify({ pages: ['/'], zones: [], outcomes: [], ...lists })

Deno.test('reads the three lists of a build', () => {
  assertEquals(
    parseBuild(build({
      pages: ['/invoices/:id', '/', '/'],
      zones: ['myapp.send', 'myapp.list', 'myapp.send'],
      outcomes: ['myapp.sent'],
    })),
    {
      pages: ['/', '/invoices/:id'],
      zones: ['myapp.list', 'myapp.send'],
      outcomes: ['myapp.sent'],
    },
  )
})

Deno.test('accepts empty zone and outcome lists', () => {
  assertEquals(parseBuild(build()), { pages: ['/'], zones: [], outcomes: [] })
  assertThrows(
    () => parseBuild(build({ pages: [] })),
    /app-analytics.json has no route pattern in "pages"/,
  )
})

Deno.test('rejects a file that is not an object of three lists', () => {
  assertThrows(() => parseBuild('/\n/invoices\n'), /app-analytics.json is not JSON/)
  assertThrows(() => parseBuild('["/"]'), /app-analytics.json is not an object of three lists/)
  assertThrows(
    () => parseBuild(JSON.stringify({ pages: ['/'], zones: [] })),
    /app-analytics.json has no "outcomes" list/,
  )
  assertThrows(
    () => parseBuild(build({ zones: 'myapp.send' })),
    /app-analytics.json has no "zones" list/,
  )
})

Deno.test('rejects a bad entry and names the list and the index', () => {
  assertThrows(
    () => parseBuild(build({ zones: ['myapp.send', 'nonamespace'] })),
    /app-analytics.json zones\[1\] "nonamespace" is not a zone name/,
  )
  assertThrows(
    () => parseBuild(build({ outcomes: ['myapp.sent', 'myapp.<b>'] })),
    /app-analytics.json outcomes\[1\] "myapp.<b>" is not an outcome name/,
  )
  assertThrows(
    () => parseBuild(build({ pages: ['/', 'invoices'] })),
    /app-analytics.json pages\[1\] "invoices" is not a route pattern/,
  )
  assertThrows(
    () => parseBuild(build({ pages: ['/', 7] })),
    /app-analytics.json pages\[1\] 7 is not a route pattern/,
  )
})

Deno.test('limits the size of the file and the number of entries of each list', () => {
  const many = Array.from({ length: MAX_LIST_ENTRIES + 1 }, (_, index) => `myapp.z${index}`)
  assertThrows(
    () => parseBuild(build({ zones: many })),
    /app-analytics.json has more than 10000 zone names in "zones"/,
  )
  assertThrows(
    () => parseBuild(build({ outcomes: ['x'.repeat(MAX_FILE_BYTES)] })),
    /app-analytics.json is larger than/,
  )
})

Deno.test('the file of a build is in the folder of the app URL', async () => {
  assertEquals(folderUrl('https://myapp.example'), 'https://myapp.example/')
  assertEquals(folderUrl('https://myapp.example/app'), 'https://myapp.example/app/')
  assertEquals(folderUrl('https://myapp.example/app/'), 'https://myapp.example/app/')
  assertEquals(folderUrl('https://myapp.example/?v=1'), null)
  assertEquals(folderUrl('ftp://myapp.example/'), null)
  assertEquals(folderUrl('myapp.example'), null)
  assertEquals(
    buildFileUrl('https://myapp.example/app/'),
    'https://myapp.example/app/app-analytics.json',
  )
  const asked = []
  const files = {
    'https://myapp.example/app/app-analytics.json': build({ zones: ['myapp.send'] }),
  }
  const fetchFile = (url) => {
    asked.push(url)
    return url in files ? Promise.resolve(files[url]) : Promise.reject(new Error(`${url} 404`))
  }
  assertEquals(await fetchBuild('https://myapp.example/app/', fetchFile), {
    pages: ['/'],
    zones: ['myapp.send'],
    outcomes: [],
  })
  assertEquals(asked, Object.keys(files))
  await assertRejects(() => fetchBuild('https://myapp.example/', fetchFile), /404/)
})
