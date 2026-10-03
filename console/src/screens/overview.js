import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { chart, table } from 'imp/std/data'
import { emptyState } from 'imp/std/display'
import { luCircleCheck } from 'imp/icons'
import { stack } from 'imp/std/layout'
import { problemsOf, runQueries } from '../lib/api.js'
import { formatCount, formatMs, formatPercent } from '../lib/format.js'
import { FAST_MS, fastMeasure } from '../lib/measures.js'
import { dailySeries, indexBy, sumOf } from '../lib/rows.js'
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

const FAST = fastMeasure()

const ratio = (part, whole) => (whole ? part / whole : null)

const overviewReport = component('aly-overview-report', {
  loading: () => reportLoading(),
  setup: async (self, scope) => {
    const api = useHttpClient(self, 'aly.api')
    const [daily, byType, perDay, pages, errors] = await runQueries(api, scope, [
      { groupBy: ['day'], measures: ['visits', 'records'] },
      { groupBy: ['type'], measures: ['records', FAST, 'readyMs.p75'] },
      {
        groupBy: ['day', 'type'],
        where: { type: ['page', 'error'] },
        measures: ['records', FAST, 'readyMs.p75'],
      },
      {
        where: { type: 'page' },
        groupBy: ['page'],
        measures: ['records', 'visits', FAST, 'readyMs.p75'],
        limit: 10,
      },
      { where: { type: 'error' }, groupBy: ['page'], measures: ['records'], limit: 10 },
    ])
    if (!daily.days) return noRecords(daily)
    const visits = sumOf(daily.rows, 'visits')
    const types = indexBy(byType.rows, 'type')
    const views = types.get('page')?.records ?? 0
    const errorCount = types.get('error')?.records ?? 0
    const days = { from: scope.from, to: scope.to }
    const pageDays = perDay.rows.filter((row) => row.type === 'page')
    const visitsPerDay = dailySeries(daily.rows, {
      ...days,
      series: [{ name: 'Visits', color: 'blue', pick: ([row]) => row.visits }],
    })
    const viewsPerDay = dailySeries(pageDays, {
      ...days,
      series: [{ name: 'Page views', color: 'teal', pick: ([row]) => row.records }],
    })
    const traffic = {
      labels: visitsPerDay.labels,
      series: [...visitsPerDay.series, ...viewsPerDay.series],
    }
    const speed = dailySeries(pageDays, {
      ...days,
      series: [{
        name: 'Fast page views',
        color: 'green',
        pick: ([row]) => row[FAST],
        empty: null,
      }],
    })
    const errorTrend = dailySeries(perDay.rows.filter((row) => row.type === 'error'), {
      ...days,
      series: [{ name: 'Errors', color: 'red', pick: ([row]) => row.records }],
    })
    const pageRows = pages.rows.map((row) => ({ id: row.page, ...row }))
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([daily, byType, perDay, pages, errors])),
      tileGrid(
        statTile({ label: 'Visits', value: formatCount(visits), hint: 'Added up per day' }),
        statTile({
          label: 'Page views',
          value: formatCount(views),
          hint: visits ? `${(views / visits).toFixed(1)} per visit` : null,
        }),
        statTile({
          label: `Ready under ${FAST_MS / 1000} s`,
          value: formatPercent(types.get('page')?.[FAST]),
          hint: 'Share of the page views',
        }),
        statTile({
          label: 'Ready time p75',
          value: formatMs(types.get('page')?.['readyMs.p75']),
          hint: '3 of 4 page views are faster',
        }),
        statTile({
          label: 'Errors',
          value: formatCount(errorCount),
          hint: views
            ? `${formatCount(Math.round(ratio(errorCount, views) * 1000) / 10)} per 100 views`
            : null,
        }),
        statTile({
          label: 'Interactions',
          value: formatCount(types.get('interaction')?.records ?? 0),
          hint: `${formatCount(types.get('outcome')?.records ?? 0)} outcomes`,
        }),
      ),
      reportCard(
        { title: 'Traffic per day', description: 'The visits and the page views of each UTC day.' },
        chart({ type: 'line', label: 'Visits and page views per day', ...traffic }),
      ),
      columns(
        reportCard(
          {
            title: 'Speed per day',
            description: `The share of the page views that were ready in less than ${
              FAST_MS / 1000
            } seconds.`,
          },
          chart({
            type: 'line',
            label: 'Fast page views per day',
            ...speed,
            format: formatPercent,
          }),
        ),
        reportCard(
          { title: 'Errors per day' },
          chart({ type: 'column', label: 'Errors per day', ...errorTrend }),
        ),
      ),
      columns(
        reportCard(
          { title: 'Top pages', description: 'The 10 pages with the most views.' },
          table({
            label: 'Top pages',
            rows: pageRows,
            columns: [
              { key: 'page', label: 'Page' },
              {
                key: 'records',
                label: 'Views',
                align: 'end',
                render: (row) => formatCount(row.records),
              },
              {
                key: 'visits',
                label: 'Visits',
                align: 'end',
                render: (row) => formatCount(row.visits),
              },
              { key: FAST, label: 'Fast', align: 'end', render: (row) => formatPercent(row[FAST]) },
            ],
          }),
        ),
        reportCard(
          { title: 'Errors per page', description: 'The 10 pages with the most errors.' },
          errors.rows.length
            ? chart({
              type: 'bar',
              label: 'Errors per page',
              labels: errors.rows.map((row) => row.page ?? '(none)'),
              series: [{
                name: 'Errors',
                color: 'red',
                values: errors.rows.map((row) => row.records),
              }],
            })
            : emptyState({
              icon: luCircleCheck,
              kind: 'success',
              title: 'No errors',
              description: 'No page sent an error record in these days.',
            }),
        ),
      ),
      dataNote(daily),
    )
  },
  error: (self, error) => reportError(error),
})

export const overviewScreen = component('aly-overview', {
  setup: (self) =>
    reportScreen(self, {
      title: 'Overview',
      description: 'The visits, the page views, the speed and the errors of the app.',
      render: (scope) => overviewReport(scope),
    }),
})
