import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { initState } from 'imp/state'
import { chart, table } from 'imp/std/data'
import { segmented } from 'imp/std/inputs'
import { stack } from 'imp/std/layout'
import { problemsOf, runQueries } from '../lib/api.js'
import { formatCount, formatMs, formatPercent } from '../lib/format.js'
import { FAST_MS, fastMeasure } from '../lib/measures.js'
import { dailySeries, labelOf, shareHistogram } from '../lib/rows.js'
import {
  columns,
  dataNote,
  noRecords,
  problemNotices,
  reportCard,
  reportError,
  reportLoading,
  reportScreen,
  statTile,
  tileGrid,
} from '../parts/report.js'

const HISTOGRAM_LIMITS = [500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 10000]

const LIMITS = [
  { value: '1000', label: '1 s' },
  { value: '2500', label: '2.5 s' },
  { value: '4000', label: '4 s' },
]

const PERCENTILES = ['readyMs.p50', 'readyMs.p75', 'readyMs.p95']

const msColumn = (key, label) => ({
  key,
  label,
  align: 'end',
  sortable: true,
  render: (row) => formatMs(row[key]),
})

const speedReport = component('aly-speed-report', {
  loading: () => reportLoading(),
  setup: async (self, { scope, limit }) => {
    const api = useHttpClient(self, 'aly.api')
    const under = fastMeasure(limit)
    const histogram = HISTOGRAM_LIMITS.map((value) => fastMeasure(value))
    const pages = { type: 'page' }
    const [overall, perDay, perPage, perCountry] = await runQueries(api, scope, [
      {
        where: pages,
        measures: [...new Set(['records', under, ...PERCENTILES, 'readyMs.avg', ...histogram])],
      },
      { where: pages, groupBy: ['day'], measures: [under, ...PERCENTILES] },
      {
        where: pages,
        groupBy: ['page'],
        measures: ['records', under, ...PERCENTILES, 'readyMs.avg'],
        limit: 100_000,
      },
      {
        where: pages,
        groupBy: ['country'],
        measures: ['records', under, 'readyMs.p75'],
        limit: 15,
      },
    ])
    if (!overall.days) return noRecords(overall)
    const [total] = overall.rows
    const shares = shareHistogram(total, HISTOGRAM_LIMITS)
    const days = { from: scope.from, to: scope.to }
    const shareTrend = dailySeries(perDay.rows, {
      ...days,
      series: [{ name: 'Fast views', color: 'green', pick: ([row]) => row[under], empty: null }],
    })
    const timeTrend = dailySeries(perDay.rows, {
      ...days,
      series: [
        { name: 'p50', color: 'blue', pick: ([row]) => row['readyMs.p50'], empty: null },
        { name: 'p75', color: 'purple', pick: ([row]) => row['readyMs.p75'], empty: null },
        { name: 'p95', color: 'orange', pick: ([row]) => row['readyMs.p95'], empty: null },
      ],
    })
    const limitLabel = formatMs(limit)
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([overall, perDay, perPage, perCountry])),
      tileGrid(
        statTile({
          label: `Ready under ${limitLabel}`,
          value: formatPercent(total?.[under]),
          hint: 'Share of the page views',
        }),
        statTile({
          label: 'Ready time p50',
          value: formatMs(total?.['readyMs.p50']),
          hint: 'Median',
        }),
        statTile({ label: 'Ready time p75', value: formatMs(total?.['readyMs.p75']) }),
        statTile({ label: 'Ready time p95', value: formatMs(total?.['readyMs.p95']) }),
        statTile({
          label: 'Page views',
          value: formatCount(total?.records ?? 0),
          hint: `Average ${formatMs(total?.['readyMs.avg'])}`,
        }),
      ),
      columns(
        reportCard(
          {
            title: 'Fast views per day',
            description: `The share of the page views that were ready in less than ${limitLabel}.`,
          },
          chart({
            type: 'line',
            label: 'Fast views per day',
            ...shareTrend,
            format: formatPercent,
          }),
        ),
        reportCard(
          { title: 'Ready time per day', description: 'The percentiles of the ready time.' },
          chart({ type: 'line', label: 'Ready time per day', ...timeTrend, format: formatMs }),
        ),
      ),
      columns(
        reportCard(
          {
            title: 'Ready time distribution',
            description: 'The share of the page views in each range of ready time.',
          },
          shares
            ? chart({
              type: 'column',
              label: 'Ready time distribution',
              labels: shares.labels,
              series: [{ name: 'Page views', color: 'indigo', values: shares.values }],
              format: formatPercent,
            })
            : dataNote(overall),
        ),
        reportCard(
          { title: 'Speed per country', description: 'The 15 countries with the most page views.' },
          chart({
            type: 'bar',
            label: 'Fast views per country',
            labels: perCountry.rows.map((row) => labelOf(row.country)),
            series: [{
              name: `Under ${limitLabel}`,
              color: 'green',
              values: perCountry.rows.map((row) => row[under]),
            }],
            format: formatPercent,
          }),
        ),
      ),
      reportCard(
        { title: 'Speed per page', description: 'Sort a column to find the slowest pages.' },
        table({
          label: 'Speed per page',
          rows: perPage.rows.map((row) => ({ id: row.page, ...row })),
          columns: [
            { key: 'page', label: 'Page', sortable: true },
            {
              key: 'records',
              label: 'Views',
              align: 'end',
              sortable: true,
              render: (row) => formatCount(row.records),
            },
            {
              key: under,
              label: `Under ${limitLabel}`,
              align: 'end',
              sortable: true,
              render: (row) => formatPercent(row[under]),
            },
            msColumn('readyMs.p50', 'p50'),
            msColumn('readyMs.p75', 'p75'),
            msColumn('readyMs.p95', 'p95'),
            msColumn('readyMs.avg', 'Average'),
          ],
        }),
      ),
      dataNote(overall),
    )
  },
  error: (self, error) => reportError(error),
})

export const speedScreen = component('aly-speed', {
  setup: (self) => {
    const limit = initState(self, 'aly.speed.limit', String(FAST_MS))
    return reportScreen(self, {
      title: 'Speed',
      description: 'How fast the pages are ready: the share of fast views, and the percentiles.',
      render: (scope) =>
        stack(
          { gap: 4 },
          segmented({ label: 'A fast view is ready in less than', value: limit, options: LIMITS }),
          limit.view((value) => speedReport({ scope, limit: Number(value) })),
        ),
    })
  },
})
