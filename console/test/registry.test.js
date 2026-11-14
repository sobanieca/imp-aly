import { expect, mockModule, test } from 'imp/test'
import { appOnServers } from '../src/lib/client.js'
import {
  refreshApp,
  registerApp,
  registerBody,
  removeApp,
  removeQuestion,
  segmentProblem,
  segmentsNote,
} from '../src/lib/registry.js'

mockModule('../src/lib/client.js', ({ spy }) => ({
  appOnServers: spy(() => Promise.resolve({ apps: [], failedServers: [] })),
}))

const row = { name: 'shop', servers: ['eu-1', 'us-2'] }

test('an action on a row goes only to the servers of that row', async () => {
  await removeApp('api', row)
  await refreshApp('api', row)
  await registerApp('api', ['us-2'], 'my-app', { segments: [] })
  expect(appOnServers.calls).toEqual([
    ['api', ['eu-1', 'us-2'], 'DELETE', '/apps/shop'],
    ['api', ['eu-1', 'us-2'], 'POST', '/apps/shop/refresh'],
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

test('the register form sends the URL of the app and the segments', () => {
  expect(registerBody({ appUrl: 'https://shop.example/', segments: ['plan'] })).toEqual({
    segments: ['plan'],
    appUrl: 'https://shop.example/',
  })
  expect(registerBody({ appUrl: 'https://shop.example/' })).toEqual({
    segments: [],
    appUrl: 'https://shop.example/',
  })
})
