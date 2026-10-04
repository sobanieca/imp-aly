import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { table } from 'imp/std/data'
import { tag } from 'imp/std/display'
import { stack } from 'imp/std/layout'
import { previousScope, problemsOf, runQuery } from '../lib/api.js'
import { barOf, bucketsOf } from '../lib/days.js'
import { formatCount } from '../lib/format.js'
import { changeOf, leastVisited, MAX_ROWS, NEVER_REACHED, withoutFields } from '../lib/reports.js'
import { indexBy } from '../lib/rows.js'
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

const countColumn = (key, label) => ({
  key,
  label,
  align: 'end',
  sortable: true,
  render: (row) => formatCount(row[key]),
})

const changeColumn = {
  key: 'percent',
  label: 'Change',
  align: 'end',
  sortable: true,
  sortValue: (row) => row.change.percent ?? Infinity,
  render: (row) => changeTag(row.change),
}

const pagesReport = component('aly-pages-report', {
  loading: () => reportLoading(),
  setup: async (self, { scope, filters, mapPages }) => {
    const api = useHttpClient(self, 'aly.api')
    const bar = barOf(scope.from, scope.to)
    const buckets = bucketsOf(scope.from, scope.to, bar)
    const where = { ...withoutFields(filters, ['page']), type: 'page' }
    const trendWhere = { ...where, ...(filters.page === undefined ? {} : { page: filters.page }) }
    const [current, before, trend] = await Promise.all([
      runQuery(api, scope, {
        where,
        groupBy: ['page'],
        measures: ['records', 'visits'],
        limit: MAX_ROWS,
      }),
      runQuery(api, previousScope(scope), {
        where,
        groupBy: ['page'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
      runQuery(api, scope, {
        where: trendWhere,
        groupBy: [bar, 'page'],
        measures: ['records'],
        limit: MAX_ROWS,
      }),
    ])
    if (!current.days) return noRecords(current)
    const previous = indexBy(before.rows, 'page')
    const withChange = (row) => {
      const earlier = previous.get(row.page)?.records ?? 0
      return { ...row, previous: earlier, change: changeOf(row.views, earlier) }
    }
    const views = current.rows.reduce((total, row) => total + row.records, 0)
    const earlier = before.rows.reduce((total, row) => total + row.records, 0)
    const top = current.rows.filter((row) => row.records > 0).slice(0, TOP).map((row) =>
      withChange({ id: row.page, page: row.page, views: row.records, visits: row.visits })
    )
    const least = leastVisited(current.rows, mapPages).map((row) =>
      withChange({ id: row.page, ...row })
    )
    const known = mapPages.length ? mapPages : current.rows.map((row) => row.page)
    const reached = known.filter((name) => current.rows.some((row) => row.page === name)).length
    const keys = filters.page === undefined ? topKeys(trend.rows, 'page') : [filters.page]
    const series = stackedSeries(trend.rows, {
      bar,
      field: 'page',
      buckets,
      keys,
      other: filters.page === undefined,
    })
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([current, before, trend])),
      tileGrid(
        statTile({
          label: 'Page views',
          value: formatCount(views),
          hint: changeHint(changeOf(views, earlier), earlier),
        }),
        statTile({
          label: 'Pages with views',
          value: `${formatCount(reached)} of ${formatCount(known.length)}`,
          hint: 'The pages of the app map',
        }),
        statTile({
          label: NEVER_REACHED,
          value: formatCount(known.length - reached),
          hint: 'Pages of the app map with no view',
        }),
      ),
      reportCard(
        {
          title: filters.page === undefined ? 'Views of the top pages' : `Views of ${filters.page}`,
          description: filters.page === undefined
            ? 'The 10 pages with the most views, and the views of all other pages as "Other".'
            : 'The views of the chosen page.',
        },
        trendChart({ label: 'Page views', bar, buckets, series }),
      ),
      stack(
        { gap: 5 },
        reportCard(
          { title: 'Most visited pages', description: 'The 10 pages with the most views.' },
          table({
            label: 'Most visited pages',
            rows: top,
            columns: [
              { key: 'page', label: 'Page', sortable: true },
              countColumn('views', 'Views'),
              countColumn('visits', 'Visits'),
              changeColumn,
            ],
          }),
        ),
        reportCard(
          {
            title: 'Least visited pages',
            description:
              'The 10 pages with the fewest views, and every page of the app map with no view.',
          },
          table({
            label: 'Least visited pages',
            rows: least,
            columns: [
              {
                key: 'page',
                label: 'Page',
                sortable: true,
                render: (row) =>
                  row.never
                    ? stack(
                      { gap: 1 },
                      row.page,
                      tag({ color: 'orange', size: 'sm' }, NEVER_REACHED),
                    )
                    : row.page,
              },
              countColumn('views', 'Views'),
              changeColumn,
            ],
          }),
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
      title: 'Pages',
      description: 'The views of each page, the most and the least visited pages.',
      filters: ['page', 'segments', 'country'],
      pageLabel: 'Page on the chart',
      render: (value) => pagesReport(value),
    }),
})
