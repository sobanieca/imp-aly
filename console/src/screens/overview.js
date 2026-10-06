import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { div } from 'imp/html'
import { computed, initState, useState } from 'imp/state'
import { link } from 'imp/std'
import { chart, table } from 'imp/std/data'
import { comboBox } from 'imp/std/inputs'
import { stack } from 'imp/std/layout'
import { app } from '../app-map.js'
import { previousScope, problemsOf, runQuery } from '../lib/api.js'
import { appNamesOf } from '../lib/catalog.js'
import { barOf, bucketLabel, bucketsOf } from '../lib/days.js'
import { formatCount, formatPercent } from '../lib/format.js'
import { changeOf, MAX_ROWS, shareOf } from '../lib/reports.js'
import { indexBy, labelOf } from '../lib/rows.js'
import { stackedSeries, topKeys } from '../lib/series.js'
import { useScope } from '../lib/scope.js'
import { APP_TERMS, OVERVIEW_TERMS } from '../lib/terms.js'
import {
  changeHint,
  changeTag,
  columns,
  noApp,
  noRecords,
  page,
  problemNotices,
  reportCard,
  reportError,
  reportLoading,
  screenHeader,
  statTile,
  tileGrid,
  trendChart,
} from '../parts/report.js'
import { scopeBar } from '../parts/scope-bar.js'

const CHART_APPS = 9

const sumVisits = (rows) => rows.reduce((total, row) => total + (row.visits ?? 0), 0)

const fastestGrowing = (rows) =>
  rows.filter((row) => row.previous > 0 && row.change.percent > 0)
    .sort((a, b) => b.change.percent - a.change.percent)[0]

const appsReport = component('aly-apps-report', {
  loading: () => reportLoading(),
  setup: async (self, { scope, names }) => {
    const api = useHttpClient(self, 'aly.api')
    const shown = initState(self, 'aly.apps.shown', [])
    const bar = barOf(scope.from, scope.to)
    const buckets = bucketsOf(scope.from, scope.to, bar)
    const earlier = previousScope(scope)
    const answers = await Promise.all(names.map(async (name) => {
      const [current, before] = await Promise.all([
        runQuery(api, { ...scope, app: name }, {
          groupBy: [bar],
          measures: ['visits'],
          limit: MAX_ROWS,
        }),
        runQuery(api, { ...earlier, app: name }, { measures: ['visits'] }),
      ])
      return { name, current, before }
    }))
    const visitsOf = new Map(answers.map(({ name, current }) => [name, sumVisits(current.rows)]))
    const total = [...visitsOf.values()].reduce((sum, count) => sum + count, 0)
    const rows = answers.map(({ name, before }) => {
      const visits = visitsOf.get(name)
      const previous = sumVisits(before.rows)
      return {
        id: name,
        app: name,
        visits,
        previous,
        change: changeOf(visits, previous),
        share: shareOf(visits, total),
      }
    }).sort((a, b) => b.visits - a.visits)
    const earlierTotal = rows.reduce((sum, row) => sum + row.previous, 0)
    const trendRows = answers.flatMap(({ name, current }) =>
      current.rows.map((row) => ({ ...row, app: name }))
    )
    const series = computed([shown], (chosen) => {
      const list = chosen.length ? chosen : names
      const picked = trendRows.filter((row) => list.includes(row.app))
      return stackedSeries(picked, {
        bar,
        field: 'app',
        value: 'visits',
        buckets,
        keys: topKeys(picked, 'app', { value: 'visits', count: CHART_APPS }),
      })
    })
    const [top] = rows
    const growing = fastestGrowing(rows)
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf(answers.flatMap(({ current, before }) => [current, before]))),
      tileGrid(
        statTile({
          label: 'Visits',
          value: formatCount(total),
          hint: changeHint(changeOf(total, earlierTotal), earlierTotal),
        }),
        statTile({
          label: 'Most visited app',
          name: true,
          value: top?.visits ? top.app : '-',
          hint: top?.visits ? `${formatCount(top.visits)} visits` : null,
        }),
        statTile({
          label: 'Fastest growing app',
          value: growing ? growing.app : '-',
          hint: growing ? changeTag(growing.change) : 'No app has more visits than before',
        }),
      ),
      reportCard(
        {
          title: 'Visits per app',
          description:
            'The visits of each app, one on top of the other. Choose the apps on the chart. Empty means all apps.',
        },
        div(comboBox({
          label: 'Apps on the chart',
          value: shown,
          multiple: true,
          options: names,
          placeholder: 'All apps',
        })),
        chart({
          type: 'column',
          stacked: true,
          label: 'Visits per app',
          labels: buckets.map((bucket) => bucketLabel(bucket, bar)),
          series,
          format: formatCount,
        }),
      ),
      reportCard(
        { title: 'All apps', description: 'The share is the part of the visits of all apps.' },
        table({
          label: 'All apps',
          rows,
          columns: [
            { key: 'app', label: 'App', sortable: true },
            {
              key: 'visits',
              label: 'Visits',
              align: 'end',
              sortable: true,
              render: (row) => formatCount(row.visits),
            },
            {
              key: 'previous',
              label: 'Previous period',
              align: 'end',
              sortable: true,
              render: (row) => formatCount(row.previous),
            },
            {
              key: 'percent',
              label: 'Change',
              align: 'end',
              sortable: true,
              sortValue: (row) => row.change.percent ?? Infinity,
              render: (row) => changeTag(row.change),
            },
            {
              key: 'share',
              label: 'Share',
              align: 'end',
              sortable: true,
              render: (row) => formatPercent(row.share),
            },
          ],
        }),
      ),
    )
  },
  error: (self, error) => reportError(error),
})

const TOP_ROWS = 5

const per100 = (part, whole) => (whole ? ((part / whole) * 100).toFixed(2) : '-')

const recordsOf = (types, type) => types.get(type)?.records ?? 0

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
    const earlier = previousScope(scope)
    const [trend, before, current, past, pages, outcomes] = await Promise.all([
      runQuery(api, scope, { groupBy: [bar], measures: ['visits'], limit: MAX_ROWS }),
      runQuery(api, earlier, { groupBy: [bar], measures: ['visits'], limit: MAX_ROWS }),
      runQuery(api, scope, { groupBy: ['type'], measures: ['records', 'visits'] }),
      runQuery(api, earlier, { groupBy: ['type'], measures: ['records'] }),
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
    const earlierVisits = sumVisits(before.rows)
    const types = indexBy(current.rows, 'type')
    const pastTypes = indexBy(past.rows, 'type')
    const views = recordsOf(types, 'page')
    const earlierViews = recordsOf(pastTypes, 'page')
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
          hint: changeHint(changeOf(visits, earlierVisits), earlierVisits),
        }),
        statTile({
          label: 'Page views',
          value: formatCount(views),
          hint: changeHint(changeOf(views, earlierViews), earlierViews),
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
            actions: moreLink(app.console.pages.href(), 'All pages'),
          },
          topTable('Top pages', ['Page', 'Views'], topRows(pages.rows, 'page')),
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
  setup: (self) => {
    const scope = useScope(self)
    const catalog = useState(self, 'aly.catalog')
    const names = computed([catalog], appNamesOf)
    const many = computed([names], (list) => list.length > 1)
    return page(
      stack(
        { gap: 5 },
        many.view((several) =>
          screenHeader({
            title: 'Overview',
            description: several
              ? 'The visits of every registered app, and how they change.'
              : 'The visits of the app, its page views, outcomes and errors, and how they change.',
            terms: several ? APP_TERMS : OVERVIEW_TERMS,
            period: true,
          })
        ),
        scopeBar({ app: false }),
        div(
          computed([scope, names], (current, list) => ({ current, list })).view((
            { current, list },
          ) => {
            if (!current.from || !list.length) return noApp(catalog)
            if (list.length > 1) return appsReport({ scope: current, names: list })
            return appOverview({ scope: { ...current, app: list[0] } })
          }),
        ),
      ),
    )
  },
})
