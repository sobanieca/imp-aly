import { expect, test } from 'imp/test'
import { mapPagesOf, segmentsOf } from '../src/lib/catalog.js'
import {
  addDays,
  addMonths,
  barNote,
  barOf,
  bucketsOf,
  dayCount,
  mondayOf,
  presetOf,
  presetRange,
  previousRange,
  todayUtc,
} from '../src/lib/days.js'
import { draftToQuery, parseQueryText, queryToDraft } from '../src/lib/query-draft.js'
import {
  activeFilters,
  changeOf,
  emptyFilters,
  errorRows,
  leastUsed,
  NEVER_REACHED,
  NEVER_USED,
  pageFlag,
  pageRows,
  RARELY,
  RARELY_VIEWED,
  withoutFields,
  zoneFlag,
  zoneRows,
} from '../src/lib/reports.js'
import { cliCommand, resultChart, toCsv } from '../src/lib/rows.js'
import { OTHER, stackedSeries, topKeys, usedSeries } from '../src/lib/series.js'

const NOW = Date.parse('2026-10-03T12:00:00Z')

test('days count in UTC and presets end today', () => {
  expect(todayUtc(NOW)).toEqual('2026-10-03')
  expect(addDays('2026-02-28', 1)).toEqual('2026-03-01')
  expect(addMonths('2026-03-31', -1)).toEqual('2026-02-28')
  expect(addMonths('2026-10-03', -60)).toEqual('2021-10-03')
  expect(dayCount('2026-09-29', '2026-10-02')).toEqual(4)
  expect(presetRange('30d', NOW)).toEqual({ start: '2026-09-04', end: '2026-10-03' })
  expect(presetRange('3m', NOW)).toEqual({ start: '2026-07-04', end: '2026-10-03' })
  expect(presetRange('1y', NOW)).toEqual({ start: '2025-10-04', end: '2026-10-03' })
  expect(presetOf({ start: '2026-07-04', end: '2026-10-03' }, NOW)).toEqual('3m')
  expect(presetOf({ start: '2026-09-26', end: '2026-10-03' }, NOW)).toEqual(undefined)
})

test('the bar size follows the length of the range', () => {
  expect(barOf('2026-09-04', '2026-10-03')).toEqual('day')
  expect(barOf('2026-08-20', '2026-10-03')).toEqual('day')
  expect(barOf('2026-08-19', '2026-10-03')).toEqual('week')
  expect(barOf('2026-03-18', '2026-10-03')).toEqual('week')
  expect(barOf('2026-03-17', '2026-10-03')).toEqual('month')
  expect(barNote('week')).toEqual('One bar is one week (UTC). A week starts on Monday.')
})

test('the previous period has the same length and ends the day before', () => {
  expect(previousRange('2026-09-04', '2026-10-03')).toEqual({
    from: '2026-08-05',
    to: '2026-09-03',
  })
  expect(previousRange('2026-10-03', '2026-10-03')).toEqual({
    from: '2026-10-02',
    to: '2026-10-02',
  })
})

test('the buckets of a range follow the bar', () => {
  expect(mondayOf('2026-10-04')).toEqual('2026-09-28')
  expect(mondayOf('2026-09-28')).toEqual('2026-09-28')
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
    page: '/',
    name: ['paid', '(none)'],
    segment: { plan: 'pro' },
  }
  const where = activeFilters(values)
  expect(where).toEqual({ page: '/', name: ['paid', null], plan: 'pro' })
  expect(withoutFields(where, ['page', 'name'])).toEqual({ plan: 'pro' })
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

test('a result exports as CSV and as a command', () => {
  expect(toCsv(['page', 'records'], [{ page: '/a,b', records: 2 }, { page: null, records: 1 }]))
    .toEqual('page,records\n"/a,b",2\n,1\n')
  expect(cliCommand({ app: 'shop', where: { name: "it's" } }, ['eu', 'us'])).toEqual(
    `imp-aly query '{"app":"shop","where":{"name":"it'\\''s"}}' -s eu,us`,
  )
})

test('the chart of a result follows the first group', () => {
  const daily = resultChart({
    rows: [{ day: '2026-10-02', visits: 3 }, { day: '2026-10-01', visits: 1 }],
    groupBy: ['day'],
    measures: ['visits'],
  })
  expect(daily.type).toEqual('line')
  expect(daily.labels).toEqual(['2026-10-01', '2026-10-02'])
  expect(daily.series[0].values).toEqual([1, 3])
  const bars = resultChart({
    rows: [{ page: '/', type: 'page', records: 4 }],
    groupBy: ['page', 'type'],
    measures: ['records'],
  })
  expect(bars.type).toEqual('bar')
  expect(bars.labels).toEqual(['/ / page'])
  const weekly = resultChart({
    rows: [{ week: '2026-09-28', records: 2 }],
    groupBy: ['week'],
    measures: ['records'],
  })
  expect(weekly.type).toEqual('line')
  expect(weekly.labels).toEqual(['2026-09-28'])
})

test('a draft and a query convert both ways', () => {
  const draft = {
    groupBy: ['page'],
    measures: ['records'],
    filters: [{ field: 'zone', values: ['(none)', 'a'] }, { field: 'type', values: [] }],
    limit: 50,
  }
  const query = draftToQuery(draft)
  expect(query).toEqual({
    where: { zone: [null, 'a'] },
    groupBy: ['page'],
    measures: ['records'],
    limit: 50,
  })
  expect(queryToDraft(query).filters).toEqual([{ field: 'zone', values: ['(none)', 'a'] }])
  expect(() => parseQueryText('[1]')).toThrow('JSON object')
  expect(() => parseQueryText('{')).toThrow('not valid JSON')
})
