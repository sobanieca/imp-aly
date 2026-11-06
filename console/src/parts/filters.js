import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { div } from 'imp/html'
import { useState } from 'imp/state'
import { button } from 'imp/std'
import { notice, skeleton } from 'imp/std/feedback'
import { comboBox, form, resetForm, select, treeSelect } from 'imp/std/inputs'
import { messageOf, runQueries } from '../lib/api.js'
import { cutListHelp, emptyFilters, MAX_VALUES } from '../lib/reports.js'
import { pageTree } from '../lib/page-tree.js'
import { labelOf } from '../lib/rows.js'

const LOOKUPS = { zone: 'seen', name: 'outcome', country: null }

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

const listOf = (value) => (Array.isArray(value) ? value : value ? [value] : [])

const initialValues = (saved, app, segments) => {
  const empty = emptyFilters(segments)
  if (!saved || saved.app !== app) return empty
  const values = saved.values ?? {}
  return {
    page: listOf(values.page),
    zone: typeof values.zone === 'string' ? values.zone : '',
    country: listOf(values.country),
    name: listOf(values.name),
    segment: Object.fromEntries(
      segments.map((segment) => [segment, listOf(values.segment?.[segment])]),
    ),
  }
}

const multiChoices = (values, current) => [...new Set([...values, ...current])].sort()

export const filterBar = component('aly-filter-bar', {
  loading: () => skeleton({ lines: 1 }),
  setup: async (self, { scope, fields, segments, mapPages }) => {
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
      lookups.map((field, index) => [field, answers[index].rows.map((row) => labelOf(row[field]))]),
    )
    const cut = Object.fromEntries(
      lookups.map((field, index) => [field, Boolean(answers[index].truncated)]),
    )
    const typed = (field) => ({
      custom: cut[field],
      help: cutListHelp(cut[field], { canType: true }),
    })
    const values = initialValues(filters.get(), scope.app, segments)
    const controls = []
    if (fields.includes('page')) {
      controls.push(
        treeSelect({
          field: 'page',
          label: 'Pages',
          items: pageTree([...mapPages, ...values.page]),
          placeholder: 'All pages',
          searchPlaceholder: 'Find a page',
        }),
      )
    }
    if (fields.includes('zone')) {
      controls.push(
        select({
          field: 'zone',
          label: 'Zone',
          options: choices('All zones', found.zone, values.zone),
          help: cutListHelp(cut.zone),
        }),
      )
    }
    if (fields.includes('name')) {
      controls.push(
        comboBox({
          field: 'name',
          label: 'Outcomes',
          multiple: true,
          options: multiChoices(found.name, values.name),
          placeholder: 'All outcomes',
          ...typed('name'),
        }),
      )
    }
    if (fields.includes('segments')) {
      for (const segment of segments) {
        controls.push(
          comboBox({
            field: `segment.${segment}`,
            label: segment,
            multiple: true,
            options: multiChoices(found[segment], values.segment[segment]),
            placeholder: 'All',
            ...typed(segment),
          }),
        )
      }
    }
    if (fields.includes('country')) {
      controls.push(
        comboBox({
          field: 'country',
          label: 'Countries',
          multiple: true,
          options: multiChoices(found.country, values.country),
          placeholder: 'All countries',
          ...typed('country'),
        }),
      )
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
