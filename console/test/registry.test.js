import { expect, mockModule, test } from 'imp/test'
import { appOnServers } from '../src/lib/client.js'
import {
  buildProblem,
  refreshApp,
  registerApp,
  originProblem,
  registerBody,
  removeApp,
  removeQuestion,
  segmentProblem,
  segmentsNote,
  withoutOtherSources,
} from '../src/lib/registry.js'

mockModule('../src/lib/client.js', ({ spy }) => ({
  appOnServers: spy(() => Promise.resolve({ apps: [], failedServers: [] })),
}))

const row = { name: 'shop', servers: ['eu-1', 'us-2'], fromUrl: ['eu-1'] }

test('an action on a row goes only to the servers of that row', async () => {
  await removeApp('api', row)
  await refreshApp('api', row)
  await registerApp('api', ['us-2'], 'my-app', { segments: [] })
  expect(appOnServers.calls).toEqual([
    ['api', ['eu-1', 'us-2'], 'DELETE', '/apps/shop'],
    ['api', ['eu-1'], 'POST', '/apps/shop/refresh'],
    ['api', ['us-2'], 'PUT', '/apps/my-app', { segments: [] }],
  ])
})

test('the remove question names every server that the remove touches', () => {
  expect(removeQuestion(row)).toEqual('Remove shop from eu-1, us-2?')
  expect(removeQuestion(null)).toEqual('Remove the app?')
})

test('the register form checks the segment names like the server', () => {
  expect(segmentProblem([])).toEqual(null)
  expect(segmentProblem(undefined)).toEqual(null)
  expect(segmentProblem(['plan', 'role'])).toEqual(null)
  expect(segmentProblem(['country'])).toEqual('"country" is a built-in field - do not declare it.')
  expect(segmentProblem(['Page'])).toEqual('"Page" is a built-in field - do not declare it.')
  expect(segmentProblem(['visits'])).toEqual('"visits" is a reserved name.')
  expect(segmentProblem(['plan', 'Plan'])).toEqual('"Plan" is given twice.')
  expect(segmentProblem(['1plan'])).toMatch(/not a name of 1 to 32 letters/)
  expect(segmentProblem(Array.from({ length: 17 }, (_, index) => `s${index}`))).toEqual(
    'An app has at most 16 segments.',
  )
})

test('the register form lists the segments that the servers know', () => {
  expect(
    segmentsNote([
      { segment: 'plan', apps: ['shop'] },
      { segment: 'role', apps: ['crm', 'shop'] },
    ]),
  ).toEqual(
    'Segments of the apps on the servers: plan (shop), role (crm, shop). The server can add the country to each record, so "country" is not a segment.',
  )
  expect(segmentsNote([])).toMatch(/^No app on the servers has a segment yet\./)
})

test('the register form checks that the build is a JSON object', () => {
  expect(buildProblem('{"pages": ["/"], "zones": [], "outcomes": []}')).toEqual(null)
  expect(buildProblem('')).toEqual('The build file is empty.')
  expect(buildProblem('  ')).toEqual('The build file is empty.')
  expect(buildProblem('{"pages": [')).toMatch(/^The build file is not valid JSON: /)
  expect(buildProblem('["/"]')).toMatch(/must be a JSON object/)
  expect(buildProblem('null')).toMatch(/must be a JSON object/)
})

test('the register form sends the build of the chosen source, and never invalid JSON', () => {
  const build = '{"pages": ["/"]}'
  const origins = ['https://shop.example']
  const values = { appUrl: 'https://shop.example/', build, segments: ['plan'], origins }
  expect(registerBody('url', values)).toEqual({
    body: { segments: ['plan'], origins, appUrl: 'https://shop.example/' },
  })
  expect(registerBody('url', { ...values, origins: [] })).toEqual({
    body: { segments: ['plan'], appUrl: 'https://shop.example/' },
  })
  expect(registerBody('text', values)).toEqual({ body: { segments: ['plan'], origins, build } })
  expect(registerBody('file', { ...values, segments: undefined })).toEqual({
    body: { segments: [], origins, build },
  })
  expect(registerBody('text', { ...values, origins: undefined }).fields.origins).toMatch(
    /needs the origins of the app/,
  )
  expect(registerBody('text', { ...values, build: '{"pages": [' }).fields.build).toMatch(
    /not valid JSON/,
  )
  expect(registerBody('file', { ...values, build: '[]' }).fields.files).toMatch(
    /must be a JSON object/,
  )
})

test('the register form takes only origins with no path', () => {
  expect(originProblem(undefined)).toEqual(null)
  expect(originProblem(['https://shop.example', 'http://localhost:5173'])).toEqual(null)
  for (const origin of [
    'https://shop.example/',
    'shop.example',
    'https://Shop.example',
    'https://shop.example:443',
    'ftp://shop.example',
  ]) {
    expect(originProblem([origin])).toMatch(/is not an origin like/)
  }
  expect(
    originProblem(Array.from({ length: 33 }, (_, index) => `https://a${index}.example`)),
  ).toEqual('An app has at most 32 origins.')
})

test('a change of the source forgets the problems of the fields of the other sources', () => {
  const errors = { name: 'bad name', appUrl: 'required', build: 'not JSON', files: 'required' }
  expect(withoutOtherSources(errors, 'text')).toEqual({ name: 'bad name', build: 'not JSON' })
  expect(withoutOtherSources(errors, 'url')).toEqual({ name: 'bad name', appUrl: 'required' })
  expect(withoutOtherSources(errors, 'file')).toEqual({ name: 'bad name', files: 'required' })
  expect(withoutOtherSources(null, 'url')).toEqual({})
})
