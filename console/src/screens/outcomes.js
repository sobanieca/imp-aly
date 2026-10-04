import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { table } from 'imp/std/data'
import { stack } from 'imp/std/layout'
import { previousScope, problemsOf, runQuery } from '../lib/api.js'
import { barOf, bucketsOf } from '../lib/days.js'
import { formatCount, formatPercent } from '../lib/format.js'
import { changeOf, MAX_ROWS, shareOf, withoutFields } from '../lib/reports.js'
import { indexBy, labelOf } from '../lib/rows.js'
import { stackedSeries, TOP, topKeys } from '../lib/series.js'
import {
  changeHint,
  changeTag,
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

const sumRecords = (rows) => rows.reduce((total, row) => total + row.records, 0)

const outcomesReport = component('aly-outcomes-report', {
  loading: () => reportLoading(),
  setup: async (self, { scope, filters }) => {
    const api = useHttpClient(self, 'aly.api')
    const bar = barOf(scope.from, scope.to)
    const buckets = bucketsOf(scope.from, scope.to, bar)
    const base = withoutFields(filters, ['name'])
    const chosen = filters.name ?? []
    const where = { ...filters, type: 'outcome' }
    const [current, before, trend, reach] = await Promise.all([
      runQuery(api, scope, {
        where,
        groupBy: ['name'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runQuery(api, previousScope(scope), {
        where,
        groupBy: ['name'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runQuery(api, scope, {
        where,
        groupBy: [bar, 'name'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runQuery(api, scope, {
        where: { ...base, type: ['page', 'outcome'] },
        groupBy: ['type'],
        measures: ['visits'],
      }),
    ])
    if (!current.days) return noRecords(current)
    const total = sumRecords(current.rows)
    const earlier = sumRecords(before.rows)
    const previous = indexBy(before.rows, 'name')
    const shown = chosen.length ? current.rows : current.rows.slice(0, TOP)
    const rows = shown.map((row) => {
      const name = labelOf(row.name)
      const last = previous.get(name)?.records ?? 0
      return {
        id: name,
        name,
        records: row.records,
        share: shareOf(row.records, total),
        previous: last,
        change: changeOf(row.records, last),
      }
    })
    const visits = indexBy(reach.rows, 'type')
    const withOutcome = visits.get('outcome')?.visits ?? 0
    const allVisits = visits.get('page')?.visits ?? 0
    const keys = chosen.length ? chosen.map(labelOf) : topKeys(trend.rows, 'name')
    const series = stackedSeries(trend.rows, {
      bar,
      field: 'name',
      buckets,
      keys,
      other: !chosen.length,
    })
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([current, before, trend, reach])),
      tileGrid(
        statTile({
          label: 'Outcomes',
          value: formatCount(total),
          hint: changeHint(changeOf(total, earlier), earlier),
        }),
        statTile({
          label: 'Visits with an outcome',
          value: formatPercent(shareOf(withOutcome, allVisits)),
          hint: `${formatCount(withOutcome)} of ${formatCount(allVisits)} visits with a page view`,
        }),
        statTile({
          label: 'Most reached outcome',
          value: current.rows[0] ? labelOf(current.rows[0].name) : '-',
          hint: current.rows[0] ? `${formatCount(current.rows[0].records)} times` : null,
        }),
      ),
      reportCard(
        {
          title: chosen.length ? 'The chosen outcomes' : 'The top outcomes',
          description: chosen.length
            ? 'The count of each chosen outcome.'
            : 'The 10 most reached outcomes, and all other outcomes as "Other".',
        },
        trendChart({ label: 'Outcomes', bar, buckets, series }),
      ),
      reportCard(
        {
          title: chosen.length ? 'Chosen outcomes' : 'Top outcomes',
          description: 'The share is the part of all the outcomes that match the filters.',
        },
        table({
          label: 'Outcomes',
          rows,
          columns: [
            { key: 'name', label: 'Outcome', sortable: true },
            {
              key: 'records',
              label: 'Count',
              align: 'end',
              sortable: true,
              render: (row) => formatCount(row.records),
            },
            {
              key: 'share',
              label: 'Share',
              align: 'end',
              sortable: true,
              render: (row) => formatPercent(row.share),
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
          ],
        }),
      ),
      dataNote(current),
    )
  },
  error: (self, error) => reportError(error),
})

export const outcomesScreen = component('aly-outcomes', {
  setup: (self) =>
    reportScreen(self, {
      title: 'Outcomes',
      description: 'How often the visits reached each outcome of the app.',
      filters: ['name', 'page', 'segments'],
      render: (value) => outcomesReport(value),
    }),
})
