import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { computed, initState } from 'imp/state'
import { button } from 'imp/std'
import { chart, table } from 'imp/std/data'
import { emptyState } from 'imp/std/display'
import { textField } from 'imp/std/inputs'
import { drawer, stack } from 'imp/std/layout'
import { problemsOf, runQueries } from '../lib/api.js'
import { formatCount, formatMs, formatPercent } from '../lib/format.js'
import { FAST_MS, fastMeasure } from '../lib/measures.js'
import { dailySeries, indexBy, labelOf, pivot } from '../lib/rows.js'
import {
  columns,
  dataNote,
  noRecords,
  problemNotices,
  reportCard,
  reportError,
  reportLoading,
  reportScreen,
  wide,
} from '../parts/report.js'

const FAST = fastMeasure()

const ALL = 100_000

const countColumn = (key, label) => ({
  key,
  label,
  align: 'end',
  sortable: true,
  render: (row) => formatCount(row[key]),
})

const pageDetail = component('aly-page-detail', {
  loading: () => reportLoading(),
  setup: async (self, { scope, page }) => {
    const api = useHttpClient(self, 'aly.api')
    const [zones, outcomes, perDay] = await runQueries(api, scope, [
      { where: { page, type: ['seen', 'interaction'] }, groupBy: ['zone', 'type'], limit: 50 },
      { where: { page, type: 'outcome' }, groupBy: ['name'], limit: 30 },
      {
        where: { page, type: ['page', 'error'] },
        groupBy: ['day', 'type'],
        measures: ['records', FAST, 'readyMs.p75'],
      },
    ])
    const zoneTable = pivot(zones.rows, { by: 'zone', across: 'type', value: 'records' })
    const zoneNames = [...zoneTable.keys()]
    const days = { from: scope.from, to: scope.to }
    const views = perDay.rows.filter((row) => row.type === 'page')
    const errors = perDay.rows.filter((row) => row.type === 'error')
    const traffic = dailySeries(views, {
      ...days,
      series: [{ name: 'Views', color: 'teal', pick: ([row]) => row.records }],
    })
    const errorSeries = dailySeries(errors, {
      ...days,
      series: [{ name: 'Errors', color: 'red', pick: ([row]) => row.records }],
    })
    const speed = dailySeries(views, {
      ...days,
      series: [{ name: 'p75', color: 'purple', pick: ([row]) => row['readyMs.p75'], empty: null }],
    })
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([zones, outcomes, perDay])),
      reportCard(
        { title: 'Views and errors per day' },
        chart({
          type: 'column',
          label: `Views and errors of ${page} per day`,
          labels: traffic.labels,
          series: [...traffic.series, ...errorSeries.series],
        }),
      ),
      reportCard(
        { title: 'Ready time p75 per day' },
        chart({ type: 'line', label: `Ready time p75 of ${page}`, ...speed, format: formatMs }),
      ),
      reportCard(
        {
          title: 'Zones',
          description: 'How often each zone was seen, and how often a person used it.',
        },
        zoneNames.length
          ? chart({
            type: 'bar',
            label: `Zones of ${page}`,
            labels: zoneNames,
            series: [
              {
                name: 'Seen',
                color: 'blue',
                values: zoneNames.map((zone) => zoneTable.get(zone).seen ?? 0),
              },
              {
                name: 'Used',
                color: 'orange',
                values: zoneNames.map((zone) => zoneTable.get(zone).interaction ?? 0),
              },
            ],
          })
          : emptyState({ title: 'No zone records', description: 'The page sent no zone.' }),
      ),
      reportCard(
        { title: 'Outcomes' },
        outcomes.rows.length
          ? chart({
            type: 'bar',
            label: `Outcomes of ${page}`,
            labels: outcomes.rows.map((row) => labelOf(row.name)),
            series: [{
              name: 'Outcomes',
              color: 'green',
              values: outcomes.rows.map((row) => row.records),
            }],
          })
          : emptyState({ title: 'No outcomes', description: 'The page sent no outcome.' }),
      ),
    )
  },
  error: (self, error) => reportError(error),
})

const pagesReport = component('aly-pages-report', {
  loading: () => reportLoading(),
  setup: async (self, scope) => {
    const api = useHttpClient(self, 'aly.api')
    const filter = initState(self, 'aly.pages.filter', '')
    const selected = initState(self, 'aly.pages.selected', null)
    const open = initState(self, 'aly.pages.open', false)
    const [byType, byPage] = await runQueries(api, scope, [
      {
        where: { type: ['page', 'interaction', 'outcome', 'error'] },
        groupBy: ['page', 'type'],
        limit: ALL,
      },
      {
        where: { type: 'page' },
        groupBy: ['page'],
        measures: ['records', 'visits', FAST, 'readyMs.p75'],
        limit: ALL,
      },
    ])
    if (!byType.days) return noRecords(byType)
    const counts = pivot(byType.rows, { by: 'page', across: 'type', value: 'records' })
    const speed = indexBy(byPage.rows, 'page')
    const rows = [...new Set([...counts.keys(), ...speed.keys()])].map((page) => ({
      id: page,
      page,
      views: counts.get(page)?.page ?? 0,
      visits: speed.get(page)?.visits ?? 0,
      interactions: counts.get(page)?.interaction ?? 0,
      outcomes: counts.get(page)?.outcome ?? 0,
      errors: counts.get(page)?.error ?? 0,
      fast: speed.get(page)?.[FAST] ?? null,
      p75: speed.get(page)?.['readyMs.p75'] ?? null,
    })).sort((a, b) => b.views - a.views)
    const show = (page) => {
      selected.set(page)
      open.set(true)
    }
    const top = rows.slice(0, 12)
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([byType, byPage])),
      columns(
        reportCard(
          { title: 'Views per page', description: 'The 12 pages with the most views.' },
          chart({
            type: 'bar',
            label: 'Views per page',
            labels: top.map((row) => row.page),
            series: [{ name: 'Views', color: 'teal', values: top.map((row) => row.views) }],
          }),
        ),
        reportCard(
          {
            title: 'Fast views per page',
            description: `The share of the views that were ready in less than ${
              FAST_MS / 1000
            } seconds.`,
          },
          chart({
            type: 'bar',
            label: 'Fast views per page',
            labels: top.map((row) => row.page),
            series: [{ name: 'Fast views', color: 'green', values: top.map((row) => row.fast) }],
            format: formatPercent,
          }),
        ),
      ),
      reportCard(
        {
          title: 'All pages',
          description: 'Choose a page to see its zones, its outcomes and its speed per day.',
        },
        textField({
          type: 'search',
          label: 'Filter',
          value: filter,
          placeholder: 'Part of a page path',
        }),
        table({
          label: 'All pages',
          rows,
          filter,
          columns: [
            {
              key: 'page',
              label: 'Page',
              sortable: true,
              render: (row) =>
                button(
                  { variant: 'link', events: { click: () => show(row.page) } },
                  row.page,
                ),
            },
            countColumn('views', 'Views'),
            countColumn('visits', 'Visits'),
            countColumn('interactions', 'Interactions'),
            countColumn('outcomes', 'Outcomes'),
            countColumn('errors', 'Errors'),
            {
              key: 'fast',
              label: `Under ${FAST_MS / 1000} s`,
              align: 'end',
              sortable: true,
              render: (row) => formatPercent(row.fast),
            },
            {
              key: 'p75',
              label: 'p75',
              align: 'end',
              sortable: true,
              render: (row) => formatMs(row.p75),
            },
          ],
        }),
      ),
      dataNote(byType),
      wide(drawer(
        { title: computed([selected], (page) => page ?? 'Page'), open },
        selected.view((page) => (page ? pageDetail({ scope, page }) : null)),
      )),
    )
  },
  error: (self, error) => reportError(error),
})

export const pagesScreen = component('aly-pages', {
  setup: (self) =>
    reportScreen(self, {
      title: 'Pages',
      description:
        'The views, the visits, the interactions, the errors and the speed of each page.',
      render: (scope) => pagesReport(scope),
    }),
})
