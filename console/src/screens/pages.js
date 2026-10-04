import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { table } from 'imp/std/data'
import { tag } from 'imp/std/display'
import { stack } from 'imp/std/layout'
import { PAGE_TERMS } from '../lib/terms.js'
import { previousScope, problemsOf, runQuery } from '../lib/api.js'
import { barOf, bucketsOf } from '../lib/days.js'
import { formatCount, formatPercent } from '../lib/format.js'
import {
  changeOf,
  leastUsed,
  MAX_ROWS,
  NEVER_REACHED,
  NEVER_USED,
  pageRows,
  RARELY_USED,
  RARELY_VIEWED,
  shareOf,
  withoutFields,
} from '../lib/reports.js'
import { stackedSeries, TOP, topKeys, usedSeries } from '../lib/series.js'
import {
  changeHint,
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

const countColumn = (key, label) => ({
  key,
  label,
  align: 'end',
  sortable: true,
  render: (row) => formatCount(row[key]),
})

const PAGE_COLUMNS = [
  { key: 'page', label: 'Page', sortable: true },
  countColumn('views', 'Views'),
  countColumn('used', 'Used'),
  {
    key: 'share',
    label: 'Used when viewed',
    align: 'end',
    sortable: true,
    sortValue: (row) => row.share ?? -1,
    render: (row) => formatPercent(row.share),
  },
  {
    key: 'flag',
    label: 'Flag',
    render: (row) =>
      row.flag ? tag({ color: row.flag === RARELY_VIEWED ? 'orange' : 'red' }, row.flag) : '',
  },
]

const totalOf = (rows, type) =>
  rows.filter((row) => row.type === type).reduce((total, row) => total + row.records, 0)

const pagesReport = component('aly-pages-report', {
  loading: () => reportLoading(),
  setup: async (self, { scope, filters, mapPages }) => {
    const api = useHttpClient(self, 'aly.api')
    const bar = barOf(scope.from, scope.to)
    const buckets = bucketsOf(scope.from, scope.to, bar)
    const one = filters.page !== undefined
    const where = { ...withoutFields(filters, ['page']), zone: null }
    const [current, before, trend] = await Promise.all([
      runQuery(api, scope, {
        where: { ...where, type: ['page', 'used'] },
        groupBy: ['page', 'type'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runQuery(api, previousScope(scope), {
        where: { ...where, type: ['page', 'used'] },
        groupBy: ['type'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runQuery(api, scope, {
        where: one ? { ...where, page: filters.page, type: ['page', 'used'] } : {
          ...where,
          type: 'used',
        },
        groupBy: [bar, one ? 'type' : 'page'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
    ])
    if (!current.days) return noRecords(current)
    const rows = pageRows(current.rows, mapPages)
    const views = totalOf(current.rows, 'page')
    const uses = totalOf(current.rows, 'used')
    const earlierViews = totalOf(before.rows, 'page')
    const earlierUses = totalOf(before.rows, 'used')
    const mostUsed = rows.filter((row) => row.used > 0).sort((a, b) =>
      b.used - a.used || b.views - a.views
    ).slice(0, TOP)
    const neverReached = rows.filter((row) => row.flag === NEVER_REACHED).length
    const neverUsed = rows.filter((row) => row.flag === NEVER_USED).length
    const series = one
      ? usedSeries(trend.rows, { bar, buckets, shownType: 'page', shownLabel: 'Viewed, not used' })
      : stackedSeries(trend.rows, {
        bar,
        field: 'page',
        buckets,
        keys: topKeys(trend.rows, 'page'),
      })
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([current, before, trend])),
      tileGrid(
        statTile({
          label: 'Page views',
          value: formatCount(views),
          hint: changeHint(changeOf(views, earlierViews), earlierViews),
        }),
        statTile({
          label: 'Page uses',
          value: formatCount(uses),
          hint: changeHint(changeOf(uses, earlierUses), earlierUses),
        }),
        statTile({
          label: 'Used when viewed',
          value: formatPercent(shareOf(uses, views)),
          hint: 'The share of the page views with a click, a tap or a key',
        }),
        statTile({
          label: 'Never reached or used',
          value: formatCount(neverReached + neverUsed),
          hint: `${formatCount(neverReached)} never reached, ${
            formatCount(neverUsed)
          } viewed but never used`,
        }),
      ),
      reportCard(
        {
          title: one ? `Uses of ${filters.page}` : 'Uses of the top pages',
          description: one
            ? 'The page views where the page was used, and where it was viewed but not used.'
            : 'The 10 most used pages, and the uses of all other pages as "Other".',
        },
        trendChart({ label: 'Page uses', bar, buckets, series }),
      ),
      stack(
        { gap: 5 },
        reportCard(
          {
            title: 'Most used pages',
            description:
              '"Used when viewed" is the share of the page views with a click, a tap or a key.',
          },
          table({ label: 'Most used pages', rows: mostUsed, columns: PAGE_COLUMNS }),
        ),
        reportCard(
          {
            title: 'Least used pages',
            description:
              `The pages with the fewest uses, and every page of the app map with no view or no use. "${RARELY_VIEWED}" marks a page viewed ${RARELY_USED.minShown} times or more and used in less than ${RARELY_USED.maxShare}% of them.`,
          },
          table({ label: 'Least used pages', rows: leastUsed(rows, TOP), columns: PAGE_COLUMNS }),
        ),
      ),
      dataNote(current),
    )
  },
  error: (self, error) => reportError(error),
})

export const pagesScreen = component('aly-pages', {
  setup: (self) =>
    reportScreen(self, {
      terms: PAGE_TERMS,
      title: 'Pages',
      description: 'How often each page was viewed and used.',
      filters: ['page', 'segments', 'country'],
      pageLabel: 'Page on the chart',
      render: (value) => pagesReport(value),
    }),
})
