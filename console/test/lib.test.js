import { expect, test } from 'imp/test'
import {
  appNamesOf,
  knownSegments,
  mapPagesOf,
  registryRows,
  segmentsOf,
  serversOfApp,
} from '../src/lib/catalog.js'
import {
  barOf,
  bucketsOf,
  presetPrevious,
  presetRange,
  previousLabel,
  todayUtc,
} from '../src/lib/ranges.js'
import { pageTree } from '../src/lib/page-tree.js'
import { periodOf, rangeOf, syncToday } from '../src/lib/scope.js'
import {
  activeFilters,
  changeOf,
  cutListHelp,
  emptyFilters,
  errorRows,
  errorTableNote,
  leastUsed,
  NEVER_REACHED,
  NEVER_USED,
  outcomeTableRows,
  pageFlag,
  pageRows,
  RARELY,
  RARELY_VIEWED,
  shownNote,
  usesTitle,
  withoutFields,
  zoneFlag,
  zoneRows,
} from '../src/lib/reports.js'
import { OTHER, stackedSeries, topKeys, usedSeries } from '../src/lib/series.js'

const NOW = Date.parse('2026-10-03T12:00:00Z')

const TODAY = '2026-10-03'

test('days count in UTC and presets end today', () => {
  expect(todayUtc(NOW)).toEqual('2026-10-03')
  expect(presetRange('30d', TODAY)).toEqual({ start: '2026-09-04', end: '2026-10-03' })
  expect(presetRange('3m', TODAY)).toEqual({ start: '2026-07-04', end: '2026-10-03' })
  expect(presetRange('1y', TODAY)).toEqual({ start: '2025-10-04', end: '2026-10-03' })
  expect(presetRange('7d', TODAY)).toEqual({ start: '2026-09-27', end: '2026-10-03' })
})

test('a preset follows the day of today, and the day moves at midnight UTC', () => {
  expect(rangeOf({ preset: '7d' }, '2026-10-03')).toEqual({
    start: '2026-09-27',
    end: '2026-10-03',
  })
  expect(rangeOf({ preset: '7d' }, '2026-10-04')).toEqual({
    start: '2026-09-28',
    end: '2026-10-04',
  })
  expect(rangeOf({ start: '2026-01-01', end: '2026-01-31' }, '2026-10-04')).toEqual({
    start: '2026-01-01',
    end: '2026-01-31',
  })
  let value = '2026-10-03'
  let sets = 0
  const today = {
    get: () => value,
    set: (day) => {
      value = day
      sets++
    },
  }
  syncToday(today, Date.parse('2026-10-03T23:59:59Z'))
  expect(sets).toEqual(0)
  syncToday(today, Date.parse('2026-10-04T00:00:01Z'))
  expect(value).toEqual('2026-10-04')
  expect(sets).toEqual(1)
})

test('the bar size follows the length of the range', () => {
  expect(barOf('2026-09-04', '2026-10-03')).toEqual('day')
  expect(barOf('2026-08-20', '2026-10-03')).toEqual('day')
  expect(barOf('2026-08-19', '2026-10-03')).toEqual('week')
  expect(barOf('2026-03-18', '2026-10-03')).toEqual('week')
  expect(barOf('2026-03-17', '2026-10-03')).toEqual('month')
})

test('the previous period of a preset has the same length and ends the day before', () => {
  expect(presetPrevious('30d', TODAY)).toEqual({ from: '2026-08-05', to: '2026-09-03' })
  expect(presetPrevious('3m', TODAY)).toEqual({ from: '2026-04-04', to: '2026-07-03' })
  expect(presetPrevious('1y', TODAY)).toEqual({ from: '2024-10-04', to: '2025-10-03' })
  expect(previousLabel('30d')).toEqual('Previous 30 days')
  expect(previousLabel('3m')).toEqual('Previous 3 months')
  expect(previousLabel('1y')).toEqual('Previous year')
  expect(previousLabel(undefined)).toEqual(null)
})

test('a period is a preset or a custom range, and a bad value falls back to 30 days', () => {
  expect(periodOf({ preset: '3m' })).toEqual({ preset: '3m' })
  expect(periodOf({ start: '2026-09-01', end: '2026-09-10' })).toEqual({
    start: '2026-09-01',
    end: '2026-09-10',
  })
  expect(periodOf({ start: '2026-09-10', end: '2026-09-01' })).toEqual({ preset: '30d' })
  expect(periodOf({ preset: 'nope' })).toEqual({ preset: '30d' })
  expect(periodOf(undefined)).toEqual({ preset: '30d' })
})

test('the pages form a tree under the nearest page that is a prefix', () => {
  expect(pageTree(['/users/:id/orders', '/', '/users', '/users/:id', '/users/invites', '/help']))
    .toEqual([
      { value: '/', label: '/' },
      { value: '/help', label: '/help' },
      {
        value: '/users',
        label: '/users',
        children: [
          {
            value: '/users/:id',
            label: '/users/:id',
            children: [{ value: '/users/:id/orders', label: '/users/:id/orders' }],
          },
          { value: '/users/invites', label: '/users/invites' },
        ],
      },
    ])
  expect(pageTree(['/users/:id/details', '/users'])).toEqual([
    {
      value: '/users',
      label: '/users',
      children: [{ value: '/users/:id/details', label: '/users/:id/details' }],
    },
  ])
})

test('the buckets of a range follow the bar', () => {
  expect(bucketsOf('2026-09-30', '2026-10-02', 'day')).toEqual([
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
  ])
  expect(bucketsOf('2026-09-30', '2026-10-12', 'week')).toEqual([
    '2026-09-28',
    '2026-10-05',
    '2026-10-12',
  ])
  expect(bucketsOf('2026-08-31', '2026-10-01', 'month')).toEqual(['2026-08', '2026-09', '2026-10'])
})

test('a stacked trend keeps the top keys and adds the rest as Other', () => {
  const rows = [
    { week: '2026-09-28', page: '/a', records: 5 },
    { week: '2026-09-28', page: '/b', records: 3 },
    { week: '2026-10-05', page: '/a', records: 2 },
    { week: '2026-10-05', page: '/c', records: 1 },
    { week: '2026-09-21', page: '/c', records: 9 },
  ]
  const buckets = ['2026-09-28', '2026-10-05']
  expect(topKeys(rows.slice(0, 4), 'page', { count: 1 })).toEqual(['/a'])
  const series = stackedSeries(rows, { bar: 'week', field: 'page', buckets, keys: ['/a'] })
  expect(series.map(({ name, values }) => ({ name, values }))).toEqual([
    { name: '/a', values: [5, 2] },
    { name: OTHER, values: [3, 1] },
  ])
  expect(stackedSeries(rows, { bar: 'week', field: 'page', buckets, keys: ['/b'], other: false }))
    .toEqual([{ name: '/b', color: 'blue', values: [3, 0] }])
  expect(stackedSeries([], { bar: 'week', field: 'page', buckets, keys: [] })).toEqual([])
})

test('a change says up or down with a whole percent', () => {
  expect(changeOf(108, 100)).toEqual({ direction: 'up', percent: 8, text: 'up 8%' })
  expect(changeOf(97, 100)).toEqual({ direction: 'down', percent: -3, text: 'down 3%' })
  expect(changeOf(100, 100).text).toEqual('no change')
  expect(changeOf(5, 0)).toEqual({ direction: 'up', percent: null, text: 'new' })
  expect(changeOf(0, 0).text).toEqual('no change')
})

test('pages get a flag when they are never reached, never used or rarely used', () => {
  expect(pageFlag({ views: 0, used: 0 })).toEqual(NEVER_REACHED)
  expect(pageFlag({ views: 10, used: 0 })).toEqual(NEVER_USED)
  expect(pageFlag({ views: 200, used: 9 })).toEqual(RARELY_VIEWED)
  expect(pageFlag({ views: 200, used: 10 })).toEqual(null)
  expect(pageRows([
    { page: '/', type: 'page', records: 200 },
    { page: '/', type: 'used', records: 50 },
    { page: '/cart', type: 'page', records: 4 },
  ], ['/', '/cart', '/account'])).toEqual([
    { id: '/', page: '/', views: 200, used: 50, share: 25, flag: null },
    { id: '/cart', page: '/cart', views: 4, used: 0, share: 0, flag: NEVER_USED },
    { id: '/account', page: '/account', views: 0, used: 0, share: null, flag: NEVER_REACHED },
  ])
})

test('the least used pages include every page with no use', () => {
  const rows = [
    { page: '/', views: 50, used: 20 },
    { page: '/cart', views: 9, used: 2 },
    { page: '/a', views: 0, used: 0 },
    { page: '/b', views: 3, used: 0 },
  ]
  expect(leastUsed(rows, 1).map(({ page }) => page)).toEqual(['/b', '/a'])
  expect(leastUsed(rows, 3).map(({ page }) => page)).toEqual(['/b', '/a', '/cart'])
})

test('the used series splits the shown records into used and not used', () => {
  const rows = [
    { day: '2026-10-01', type: 'page', records: 10 },
    { day: '2026-10-01', type: 'used', records: 4 },
    { day: '2026-10-02', type: 'page', records: 3 },
  ]
  expect(usedSeries(rows, {
    bar: 'day',
    buckets: ['2026-10-01', '2026-10-02'],
    shownType: 'page',
    shownLabel: 'Viewed, not used',
  })).toEqual([
    { name: 'Used', color: 'blue', values: [4, 0] },
    { name: 'Viewed, not used', color: 'gray', values: [6, 3] },
  ])
})

test('zones get a flag when they are never used or rarely used', () => {
  expect(zoneFlag({ seen: 10, used: 0 })).toEqual(NEVER_USED)
  expect(zoneFlag({ seen: 200, used: 9 })).toEqual(RARELY)
  expect(zoneFlag({ seen: 200, used: 10 })).toEqual(null)
  expect(zoneFlag({ seen: 99, used: 1 })).toEqual(null)
  expect(zoneRows([
    { zone: 'hero', page: '/', type: 'seen', records: 200 },
    { zone: 'hero', page: '/', type: 'used', records: 50 },
    { zone: null, page: '/', type: 'used', records: 80 },
  ])).toEqual([{
    id: 'hero /',
    zone: 'hero',
    page: '/',
    seen: 200,
    used: 50,
    share: 25,
    flag: null,
  }])
})

test('the errors per page come with the views of the same answer', () => {
  expect(errorRows([
    { page: '/', type: 'page', records: 400 },
    { page: '/', type: 'error', records: 2 },
    { page: '/cart', type: 'error', records: 1 },
  ])).toEqual([
    { id: '/', page: '/', views: 400, errors: 2, per100: 0.5 },
    { id: '/cart', page: '/cart', views: 0, errors: 1, per100: null },
  ])
})

test('the filters turn into the where of a query', () => {
  const values = {
    ...emptyFilters(['plan']),
    page: ['/', '/cart'],
    zone: 'shop.hero',
    country: ['PL'],
    name: ['paid', '(none)'],
    segment: { plan: ['pro', '(none)'] },
  }
  const where = activeFilters(values)
  expect(where).toEqual({
    zone: 'shop.hero',
    page: ['/', '/cart'],
    country: ['PL'],
    name: ['paid', null],
    plan: ['pro', null],
  })
  expect(withoutFields(where, ['page', 'name', 'zone', 'country'])).toEqual({ plan: ['pro', null] })
  expect(activeFilters(emptyFilters(['plan']))).toEqual({})
})

test('the catalog joins the app maps and the segments of all servers', () => {
  const catalog = {
    apps: [
      { server: 'eu', name: 'shop', pages: ['/', '/cart'], segments: ['plan'] },
      { server: 'us', name: 'shop', pages: ['/', '/account'], segments: ['plan', 'role'] },
      { server: 'us', name: 'blog', pages: ['/post'], segments: [] },
    ],
  }
  expect(mapPagesOf(catalog, 'shop')).toEqual(['/', '/account', '/cart'])
  expect(segmentsOf(catalog, 'shop')).toEqual(['plan', 'role'])
})

test('the app list has each app once, and an app asks only the servers that have it', () => {
  const catalog = {
    apps: [
      { server: 'eu', name: 'shop' },
      { server: 'eu', name: 'crm' },
      { server: 'us', name: 'shop' },
      { server: 'us', name: 'docs' },
    ],
  }
  expect(appNamesOf(catalog)).toEqual(['crm', 'docs', 'shop'])
  expect(serversOfApp(catalog, 'shop')).toEqual(['eu', 'us'])
  expect(serversOfApp(catalog, 'docs')).toEqual(['us'])
  expect(serversOfApp(catalog, 'crm')).toEqual(['eu'])
  expect(serversOfApp(catalog, 'gone')).toEqual([])
  expect(serversOfApp(undefined, 'shop')).toEqual([])
})

test('the registry has one row per app, with its servers and the sum of its records', () => {
  const entry = (server, more) => ({
    server,
    name: 'shop',
    pages: ['/'],
    zones: [],
    outcomes: [],
    segments: [],
    accepted: 1,
    rejected: 0,
    appUrl: null,
    buildError: null,
    ...more,
  })
  const [crm, shop] = registryRows({
    apps: [
      entry('eu', { appUrl: 'https://shop.example/', pages: ['/', '/cart'], accepted: 5 }),
      entry('us', { segments: ['plan'], rejected: 2, buildError: 'no file' }),
      entry('us', { name: 'crm' }),
    ],
  })
  expect(crm.servers).toEqual(['us'])
  expect({
    servers: shop.servers,
    fromUrl: shop.fromUrl,
    pages: shop.pages,
    segments: shop.segments,
    accepted: shop.accepted,
    rejected: shop.rejected,
    buildErrors: shop.buildErrors,
  }).toEqual({
    servers: ['eu', 'us'],
    fromUrl: ['eu'],
    pages: ['/', '/cart'],
    segments: ['plan'],
    accepted: 6,
    rejected: 2,
    buildErrors: 1,
  })
})

test('the known segments name the apps that declare them', () => {
  const catalog = {
    apps: [
      { name: 'shop', server: 'eu-1', segments: ['plan', 'role'] },
      { name: 'shop', server: 'us-2', segments: ['plan'] },
      { name: 'crm', server: 'us-2', segments: ['role'] },
      { name: 'docs', server: 'us-2' },
    ],
  }
  expect(knownSegments(catalog)).toEqual([
    { segment: 'plan', apps: ['shop'] },
    { segment: 'role', apps: ['crm', 'shop'] },
  ])
  expect(knownSegments(undefined)).toEqual([])
})

test('a table that leaves out rows says so', () => {
  expect(shownNote(10, 10, 'outcomes')).toEqual(null)
  expect(shownNote(10, 1234, 'outcomes')).toEqual('Showing 10 of 1,234 outcomes.')
  expect(errorTableNote({ chosen: 0, withErrors: 25, shown: 10 })).toEqual(
    'Showing 10 of 25 pages with errors.',
  )
  expect(errorTableNote({ chosen: 0, withErrors: 4, shown: 4 })).toEqual(null)
  expect(errorTableNote({ chosen: 3, withErrors: 3, shown: 3 })).toEqual(null)
  expect(errorTableNote({ chosen: 3, withErrors: 2, shown: 2 })).toEqual(
    'Showing 2 of 3 chosen pages. The table leaves out 1 chosen page with no errors.',
  )
})

test('the outcomes table shows the top outcomes, or every chosen outcome', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    name: index ? `o${index}` : null,
    records: 100 - index,
  }))
  const top = outcomeTableRows(rows, [], 10)
  expect(top.rows.length).toEqual(10)
  expect(top.rows[0]).toEqual({ name: '(none)', records: 100 })
  expect(top.note).toEqual('Showing 10 of 12 outcomes.')
  const chosen = outcomeTableRows([{ name: 'paid', records: 4 }], ['paid', 'signup', null], 10)
  expect(chosen.rows).toEqual([
    { name: 'paid', records: 4 },
    { name: 'signup', records: 0 },
    { name: '(none)', records: 0 },
  ])
  expect(chosen.note).toEqual(null)
})

test('a filter list that the servers cut says so', () => {
  expect(cutListHelp(false)).toEqual(undefined)
  expect(cutListHelp(true)).toEqual('The list shows the 300 values with the most records.')
  expect(cutListHelp(true, { canType: true })).toEqual(
    'The list shows the 300 values with the most records. Type another value and press Enter.',
  )
})

test('the chart of the (none) zone names it as the filter does', () => {
  expect(usesTitle(null)).toEqual('Uses of (none)')
  expect(usesTitle('shop.cart')).toEqual('Uses of shop.cart')
})
