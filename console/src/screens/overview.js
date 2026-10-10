import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { link } from 'imp/std'
import { table } from 'imp/std/data'
import { stack } from 'imp/std/layout'
import { app } from '../app-map.js'
import { problemsOf, runPrevious, runQuery } from '../lib/api.js'
import { barOf, bucketsOf } from '../lib/ranges.js'
import { formatCount, formatPercent } from '../lib/format.js'
import { MAX_ROWS, shareOf } from '../lib/reports.js'
import { indexBy, labelOf } from '../lib/rows.js'
import { OVERVIEW_TERMS } from '../lib/terms.js'
import {
  changeHint,
  columns,
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

const HOME_PAGE = '/'

const sumVisits = (rows) => rows.reduce((total, row) => total + (row.visits ?? 0), 0)

const TOP_ROWS = 5

const per100 = (part, whole) => (whole ? ((part / whole) * 100).toFixed(2) : '-')

const recordsOf = (types, type) => types?.get(type)?.records ?? 0

const topRows = (rows, field) =>
  rows.map((row) => ({ id: labelOf(row[field]), label: labelOf(row[field]), count: row.records }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1))
    .slice(0, TOP_ROWS)

const topTable = (label, [heading, counted], rows) =>
  table({
    label,
    rows,
    columns: [
      { key: 'label', label: heading },
      { key: 'count', label: counted, align: 'end', render: (row) => formatCount(row.count) },
    ],
  })

const moreLink = (href, label) => link({ href, size: 'sm' }, label)

const appOverview = component('aly-app-overview', {
  loading: () => reportLoading(),
  setup: async (self, { scope }) => {
    const api = useHttpClient(self, 'aly.api')
    const bar = barOf(scope.from, scope.to)
    const buckets = bucketsOf(scope.from, scope.to, bar)
    const [trend, before, current, past, pages, outcomes] = await Promise.all([
      runQuery(api, scope, { groupBy: [bar], measures: ['visits'], limit: MAX_ROWS }),
      runPrevious(api, scope, { groupBy: [bar], measures: ['visits'], limit: MAX_ROWS }),
      runQuery(api, scope, { groupBy: ['type'], measures: ['records', 'visits'] }),
      runPrevious(api, scope, { groupBy: ['type'], measures: ['records'] }),
      runQuery(api, scope, {
        where: { type: 'page' },
        groupBy: ['page'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runQuery(api, scope, {
        where: { type: 'outcome' },
        groupBy: ['name'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
    ])
    if (!trend.days) return noRecords(trend)
    const visits = sumVisits(trend.rows)
    const earlierVisits = before ? sumVisits(before.rows) : null
    const types = indexBy(current.rows, 'type')
    const views = recordsOf(types, 'page')
    const earlierViews = past ? recordsOf(indexBy(past.rows, 'type'), 'page') : null
    const errors = recordsOf(types, 'error')
    const withOutcome = types.get('outcome')?.visits ?? 0
    const withPage = types.get('page')?.visits ?? 0
    const position = new Map(buckets.map((bucket, index) => [bucket, index]))
    const values = buckets.map(() => 0)
    for (const row of trend.rows) {
      const index = position.get(row[bar])
      if (index !== undefined) values[index] += row.visits ?? 0
    }
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([trend, before, current, past, pages, outcomes])),
      tileGrid(
        statTile({
          label: 'Visits',
          value: formatCount(visits),
          hint: changeHint(visits, earlierVisits, scope),
        }),
        statTile({
          label: 'Page views',
          value: formatCount(views),
          hint: changeHint(views, earlierViews, scope),
        }),
        statTile({
          label: 'Visits with an outcome',
          value: formatPercent(shareOf(withOutcome, withPage)),
          hint: `${formatCount(withOutcome)} of ${formatCount(withPage)} visits`,
        }),
        statTile({
          label: 'Errors per 100 views',
          value: per100(errors, views),
          hint: `${formatCount(errors)} errors`,
        }),
      ),
      reportCard(
        { title: 'Visits' },
        trendChart({
          label: 'Visits',
          bar,
          buckets,
          series: [{ name: 'Visits', color: 'blue', values }],
        }),
      ),
      columns(
        reportCard(
          {
            title: 'Top pages',
            description: `Without the home page ${HOME_PAGE}, which most visits open.`,
            actions: moreLink(app.console.pages.href(), 'All pages'),
          },
          topTable(
            'Top pages',
            ['Page', 'Views'],
            topRows(pages.rows.filter((row) => row.page !== HOME_PAGE), 'page'),
          ),
        ),
        reportCard(
          {
            title: 'Top outcomes',
            actions: moreLink(app.console.outcomes.href(), 'All outcomes'),
          },
          topTable('Top outcomes', ['Outcome', 'Count'], topRows(outcomes.rows, 'name')),
        ),
      ),
    )
  },
  error: (self, error) => reportError(error),
})

export const overviewScreen = component('aly-overview', {
  setup: (self) =>
    reportScreen(self, {
      terms: OVERVIEW_TERMS,
      title: 'Overview',
      description:
        'The visits of the app, its page views, outcomes and errors, and how they change.',
      render: (value) => appOverview(value),
    }),
})
