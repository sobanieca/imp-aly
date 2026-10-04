import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { div } from 'imp/html'
import { useState } from 'imp/state'
import { button } from 'imp/std'
import { notice, skeleton } from 'imp/std/feedback'
import { comboBox, form, resetForm, select } from 'imp/std/inputs'
import { messageOf, runQueries } from '../lib/api.js'
import { emptyFilters } from '../lib/reports.js'
import { labelOf } from '../lib/rows.js'

const LOOKUPS = { zone: 'seen', name: 'outcome', country: null }

const MAX_VALUES = 300

const filterKeeper = component('aly-filter-keeper', {
  setup: (self, app) => {
    const filters = useState(self, 'aly.report.filters')
    useState(self, 'imp.form').watch(self, (values) => {
      if (values) filters.set({ app, values })
    })
    return []
  },
})

const filterRow = component('aly-filter-row', {
  styles: `
    :host { display: block; }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: var(--imp-space-3, 12px);
    }
    .cell { flex: 0 1 13rem; min-inline-size: 10rem; }
  `,
  setup: (self, controls, action) =>
    div({ class: 'row' }, ...controls.map((control) => div({ class: 'cell' }, control)), action),
})

const choices = (all, values, current) => [
  { value: '', label: all },
  ...[...new Set([...values, ...(current ? [current] : [])])].sort(),
]

const initialValues = (saved, app, segments) => {
  const empty = emptyFilters(segments)
  if (!saved || saved.app !== app) return empty
  return {
    ...empty,
    ...saved.values,
    segment: { ...empty.segment, ...saved.values.segment },
  }
}

export const filterBar = component('aly-filter-bar', {
  loading: () => skeleton({ lines: 1 }),
  setup: async (self, { scope, fields, segments, mapPages, pageLabel = 'Page' }) => {
    const api = useHttpClient(self, 'aly.api')
    const filters = useState(self, 'aly.report.filters')
    const lookups = [
      ...fields.filter((field) => field in LOOKUPS),
      ...(fields.includes('segments') ? segments : []),
    ]
    const answers = await runQueries(
      api,
      scope,
      lookups.map((field) => ({
        ...(LOOKUPS[field] ? { where: { type: LOOKUPS[field] } } : {}),
        groupBy: [field],
        measures: ['records'],
        limit: MAX_VALUES,
      })),
    )
    const found = Object.fromEntries(
      lookups.map((field, index) => [
        field,
        answers[index].rows.map((row) => labelOf(row[field])),
      ]),
    )
    const values = initialValues(filters.get(), scope.app, segments)
    const controls = []
    if (fields.includes('page')) {
      controls.push(select({
        field: 'page',
        label: pageLabel,
        options: choices('All pages', mapPages, values.page),
      }))
    }
    if (fields.includes('zone')) {
      controls.push(select({
        field: 'zone',
        label: 'Zone',
        options: choices('All zones', found.zone, values.zone),
      }))
    }
    if (fields.includes('name')) {
      controls.push(comboBox({
        field: 'name',
        label: 'Outcomes',
        multiple: true,
        options: [...new Set([...found.name, ...values.name])].sort(),
        placeholder: 'All outcomes',
      }))
    }
    if (fields.includes('segments')) {
      for (const segment of segments) {
        controls.push(select({
          field: `segment.${segment}`,
          label: segment,
          options: choices('All', found[segment], values.segment[segment]),
        }))
      }
    }
    if (fields.includes('country')) {
      controls.push(select({
        field: 'country',
        label: 'Country',
        options: choices('All countries', found.country, values.country),
      }))
    }
    return form(
      { initialValues: values },
      filterKeeper(scope.app),
      filterRow(
        controls,
        button(
          {
            variant: 'ghost',
            events: { click: (event) => resetForm(event, emptyFilters(segments)) },
          },
          'Clear the filters',
        ),
      ),
    )
  },
  error: (self, error) =>
    notice({ kind: 'warning', title: 'The filters did not load' }, messageOf(error)),
})
