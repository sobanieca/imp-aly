import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { table } from 'imp/std/data'
import { emptyState } from 'imp/std/display'
import { stack } from 'imp/std/layout'
import { luCircleCheck } from 'imp/icons'
import { ERROR_TERMS } from '../lib/terms.js'
import { problemsOf, runPrevious, runQuery } from '../lib/api.js'
import { barOf, bucketsOf } from '../lib/days.js'
import { formatCount } from '../lib/format.js'
import { changeOf, errorRows, MAX_ROWS } from '../lib/reports.js'
import { stackedSeries, TOP, topKeys } from '../lib/series.js'
import {
  changeHint,
  compareColumns,
  dataNote,
  noRecords,
  problemNotices,
  reportCard,
  reportError,
  reportLoading,
  reportScreen,
  statTile,
  tileGrid,
  trendChart,
} from '../parts/report.js'

const per100 = (value) => (value === null ? '-' : value.toFixed(2))

const errorsReport = component('aly-errors-report', {
  loading: () => reportLoading(),
  setup: async (self, { scope, filters, mapPages }) => {
    const api = useHttpClient(self, 'aly.api')
    const bar = barOf(scope.from, scope.to)
    const buckets = bucketsOf(scope.from, scope.to, bar)
    const chosen = filters.page ?? []
    const one = chosen.length === 1
    const where = { ...filters, type: ['page', 'error'] }
    const [current, before, trend] = await Promise.all([
      runQuery(api, scope, {
        where,
        groupBy: ['page', 'type'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runPrevious(api, scope, {
        where,
        groupBy: ['page', 'type'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runQuery(api, scope, {
        where: { ...filters, type: 'error' },
        groupBy: [bar, 'page'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
    ])
    if (!current.days) return noRecords(current)
    const pages = errorRows(current.rows)
    const previous = before
      ? new Map(errorRows(before.rows).map((row) => [row.page, row.errors]))
      : null
    const errors = pages.reduce((total, row) => total + row.errors, 0)
    const views = pages.reduce((total, row) => total + row.views, 0)
    const earlier = previous
      ? [...previous.values()].reduce((total, count) => total + count, 0)
      : null
    const rows = pages.filter((row) => row.errors > 0).sort((a, b) => b.errors - a.errors)
      .slice(0, TOP).map((row) => {
        const last = previous ? previous.get(row.page) ?? 0 : null
        return { ...row, previous: last, change: previous ? changeOf(row.errors, last) : null }
      })
    const known = chosen.length ? chosen : mapPages.length ? mapPages : pages.map((row) => row.page)
    const failing = known.filter((name) => pages.some((row) => row.page === name && row.errors))
    const keys = chosen.length ? chosen : topKeys(trend.rows, 'page')
    const series = stackedSeries(trend.rows, {
      bar,
      field: 'page',
      buckets,
      keys,
      other: !chosen.length,
    })
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([current, before, trend])),
      tileGrid(
        statTile({
          label: 'Errors',
          value: formatCount(errors),
          hint: changeHint(errors, earlier, scope, { upIsBad: true }),
        }),
        statTile({
          label: 'Errors per 100 views',
          value: per100(views ? (errors / views) * 100 : null),
          hint: `${formatCount(views)} page views`,
        }),
        statTile({
          label: 'Pages with errors',
          value: `${formatCount(failing.length)} of ${formatCount(known.length)}`,
          hint: 'The pages of the app map',
        }),
      ),
      reportCard(
        {
          title: one
            ? `Errors of ${chosen[0]}`
            : chosen.length
            ? 'Errors of the chosen pages'
            : 'Errors of the top pages',
          description: `${
            chosen.length
              ? 'The errors of each chosen page.'
              : 'The 10 pages with the most errors, and the errors of all other pages as "Other".'
          } One error record stands for up to 5 seconds of failures on one page view.`,
        },
        trendChart({ label: 'Errors', bar, buckets, series }),
      ),
      reportCard(
        {
          title: chosen.length ? 'The chosen pages with errors' : 'Pages with the most errors',
          description: 'The errors per 100 views come from the same query as the views.',
        },
        rows.length
          ? table({
            label: 'Pages with the most errors',
            rows,
            columns: [
              { key: 'page', label: 'Page', sortable: true },
              {
                key: 'errors',
                label: 'Errors',
                align: 'end',
                sortable: true,
                render: (row) => formatCount(row.errors),
              },
              {
                key: 'views',
                label: 'Page views',
                align: 'end',
                sortable: true,
                render: (row) => formatCount(row.views),
              },
              {
                key: 'per100',
                label: 'Per 100 views',
                align: 'end',
                sortable: true,
                sortValue: (row) => row.per100 ?? Infinity,
                render: (row) => per100(row.per100),
              },
              ...compareColumns(scope, { upIsBad: true }),
            ],
          })
          : emptyState({
            icon: luCircleCheck,
            kind: 'success',
            title: 'No errors',
            description: 'No page sent an error record in these days.',
          }),
      ),
      dataNote(current),
    )
  },
  error: (self, error) => reportError(error),
})

export const errorsScreen = component('aly-errors', {
  setup: (self) =>
    reportScreen(self, {
      terms: ERROR_TERMS,
      title: 'Errors',
      description: 'The pages with errors, and the errors per 100 page views.',
      filters: ['page', 'segments'],
      render: (value) => errorsReport(value),
    }),
})
