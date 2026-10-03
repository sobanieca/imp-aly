import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { useState } from 'imp/state'
import { chart, table } from 'imp/std/data'
import { emptyState } from 'imp/std/display'
import { stack } from 'imp/std/layout'
import { problemsOf, runQueries } from '../lib/api.js'
import { formatCount, formatMs, formatPercent } from '../lib/format.js'
import { fastMeasure, RECORD_TYPES } from '../lib/measures.js'
import { indexBy, labelOf } from '../lib/rows.js'
import {
  columns,
  dataNote,
  noRecords,
  problemNotices,
  reportCard,
  reportError,
  reportLoading,
  reportScreen,
} from '../parts/report.js'

const FAST = fastMeasure()

const segmentsOf = (catalog, app) => [
  ...new Set(
    (catalog?.apps ?? []).filter(({ name }) => name === app).flatMap(({ segments }) => segments),
  ),
]

const visitsChart = (label, rows, field, color) =>
  chart({
    type: 'bar',
    label,
    labels: rows.map((row) => labelOf(row[field])),
    series: [{ name: 'Visits', color, values: rows.map((row) => row.visits) }],
  })

const audienceReport = component('aly-audience-report', {
  loading: () => reportLoading(),
  setup: async (self, { scope, segments }) => {
    const api = useHttpClient(self, 'aly.api')
    const [countries, countryViews, types, ...bySegment] = await runQueries(api, scope, [
      { groupBy: ['country'], measures: ['visits'], limit: 300 },
      {
        where: { type: 'page' },
        groupBy: ['country'],
        measures: ['records', FAST, 'readyMs.p75'],
        limit: 300,
      },
      { groupBy: ['type'], measures: ['records', 'visits'] },
      ...segments.map((segment) => ({ groupBy: [segment], measures: ['visits'], limit: 30 })),
    ])
    if (!countries.days) return noRecords(countries)
    const views = indexBy(countryViews.rows, 'country')
    const countryRows = countries.rows.map((row) => {
      const key = labelOf(row.country)
      return {
        id: key,
        country: key,
        visits: row.visits,
        views: views.get(key)?.records ?? 0,
        fast: views.get(key)?.[FAST] ?? null,
        p75: views.get(key)?.['readyMs.p75'] ?? null,
      }
    })
    const typeRows = indexBy(types.rows, 'type')
    return stack(
      { gap: 5 },
      ...problemNotices(problemsOf([countries, countryViews, types, ...bySegment])),
      columns(
        reportCard(
          {
            title: 'Visits per country',
            description:
              'The 15 countries with the most visits. The server must store the country.',
          },
          visitsChart('Visits per country', countries.rows.slice(0, 15), 'country', 'blue'),
        ),
        reportCard(
          { title: 'Records per type', description: 'What the app sends.' },
          chart({
            type: 'column',
            label: 'Records per type',
            labels: RECORD_TYPES,
            series: [
              {
                name: 'Records',
                color: 'teal',
                values: RECORD_TYPES.map((type) => typeRows.get(type)?.records ?? 0),
              },
              {
                name: 'Visits',
                color: 'blue',
                values: RECORD_TYPES.map((type) => typeRows.get(type)?.visits ?? 0),
              },
            ],
          }),
        ),
      ),
      segments.length
        ? columns(
          ...segments.map((segment, index) =>
            reportCard(
              {
                title: `Visits per ${segment}`,
                description: `The values of the segment ${segment}.`,
              },
              visitsChart(`Visits per ${segment}`, bySegment[index].rows, segment, 'purple'),
            )
          ),
        )
        : reportCard(
          { title: 'Segments' },
          emptyState({
            title: 'The app has no segments',
            description:
              'Register the app again with segments, such as plan or role, to split the visits.',
          }),
        ),
      reportCard(
        { title: 'All countries' },
        table({
          label: 'All countries',
          rows: countryRows,
          columns: [
            { key: 'country', label: 'Country', sortable: true },
            {
              key: 'visits',
              label: 'Visits',
              align: 'end',
              sortable: true,
              render: (row) => formatCount(row.visits),
            },
            {
              key: 'views',
              label: 'Page views',
              align: 'end',
              sortable: true,
              render: (row) => formatCount(row.views),
            },
            {
              key: 'fast',
              label: 'Under 2.5 s',
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
      dataNote(countries),
    )
  },
  error: (self, error) => reportError(error),
})

export const audienceScreen = component('aly-audience', {
  setup: (self) => {
    const catalog = useState(self, 'aly.catalog')
    return reportScreen(self, {
      title: 'Audience',
      description: 'Where the visits come from, and how the segments of the app split them.',
      render: (scope) => audienceReport({ scope, segments: segmentsOf(catalog.get(), scope.app) }),
    })
  },
})
