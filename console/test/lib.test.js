import { expect, test } from 'imp/test'
import { addDays, daysBetween, presetOf, presetRange, todayUtc } from '../src/lib/days.js'
import { formatMeasure, formatMs, measureLabel } from '../src/lib/format.js'
import { draftToQuery, parseQueryText, queryToDraft } from '../src/lib/query-draft.js'
import {
  cliCommand,
  dailySeries,
  pivot,
  resultChart,
  shareHistogram,
  toCsv,
} from '../src/lib/rows.js'

const NOW = Date.parse('2026-10-03T12:00:00Z')

test('days count in UTC and presets end today', () => {
  expect(todayUtc(NOW)).toEqual('2026-10-03')
  expect(addDays('2026-02-28', 1)).toEqual('2026-03-01')
  expect(daysBetween('2026-09-29', '2026-10-02')).toEqual([
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
  ])
  expect(presetRange('7', NOW)).toEqual({ start: '2026-09-27', end: '2026-10-03' })
  expect(presetOf({ start: '2026-09-27', end: '2026-10-03' }, NOW)).toEqual('7')
  expect(presetOf({ start: '2026-09-26', end: '2026-10-03' }, NOW)).toEqual(undefined)
})

test('measures format by their unit', () => {
  expect(formatMs(420)).toEqual('420 ms')
  expect(formatMs(1650)).toEqual('1.65 s')
  expect(formatMeasure('readyMs.under:2500', 87.4)).toEqual('87.4%')
  expect(formatMeasure('readyMs.p75', 12500)).toEqual('12.5 s')
  expect(formatMeasure('visits', 1612)).toEqual('1,612')
  expect(formatMeasure('records', null)).toEqual('-')
  expect(measureLabel('readyMs.under:2500')).toEqual('Ready under 2.5 s')
})

test('daily series fill the days with no data', () => {
  const series = dailySeries([{ day: '2026-10-02', visits: 5 }], {
    from: '2026-10-01',
    to: '2026-10-03',
    series: [{ name: 'Visits', pick: ([row]) => row.visits }],
  })
  expect(series).toEqual({
    labels: ['10-01', '10-02', '10-03'],
    series: [{ name: 'Visits', color: undefined, values: [0, 5, 0] }],
  })
})

test('a pivot keys null as (none)', () => {
  const table = pivot([
    { zone: 'a', type: 'seen', records: 3 },
    { zone: null, type: 'interaction', records: 2 },
  ], { by: 'zone', across: 'type', value: 'records' })
  expect(table.get('a')).toEqual({ seen: 3 })
  expect(table.get('(none)')).toEqual({ interaction: 2 })
})

test('the share histogram turns cumulative shares into ranges', () => {
  const row = { 'readyMs.under:1000': 40, 'readyMs.under:2500': 90 }
  expect(shareHistogram(row, [1000, 2500])).toEqual({
    labels: ['< 1 s', '1-2.5 s', '>= 2.5 s'],
    values: [40, 50, 10],
  })
  expect(shareHistogram({}, [1000])).toEqual(null)
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
