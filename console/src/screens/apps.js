import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { div } from 'imp/html'
import { computed, initState, useState } from 'imp/state'
import { chart, table } from 'imp/std/data'
import { comboBox } from 'imp/std/inputs'
import { stack } from 'imp/std/layout'
import { previousScope, problemsOf, runQuery } from '../lib/api.js'
import { appNamesOf } from '../lib/catalog.js'
import { barOf, bucketLabel, bucketsOf } from '../lib/days.js'
import { formatCount, formatPercent } from '../lib/format.js'
import { changeOf, MAX_ROWS, shareOf } from '../lib/reports.js'
import { stackedSeries, topKeys } from '../lib/series.js'
import { useScope } from '../lib/scope.js'
import { APP_TERMS } from '../lib/terms.js'
import {
  changeHint,
  changeTag,
  noApp,
  page,
  problemNotices,
  reportCard,
  reportError,
  reportLoading,
  screenHeader,
  statTile,
  tileGrid,
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

export const appsScreen = component('aly-apps', {
  setup: (self) => {
    const scope = useScope(self)
    const catalog = useState(self, 'aly.catalog')
    const names = computed([catalog], appNamesOf)
    return page(
      stack(
        { gap: 5 },
        screenHeader('Apps', 'The visits of every registered app, and how they change.', APP_TERMS),
        scopeBar({ app: false, note: true }),
        div(
          computed([scope, names], (current, list) => ({ current, list })).view((
            { current, list },
          ) =>
            current.from && list.length
              ? appsReport({ scope: current, names: list })
              : noApp(catalog)
          ),
        ),
      ),
    )
  },
})
