import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { div } from 'imp/html'
import { computed, initState, useState } from 'imp/state'
import { button, icon, menuButton, text } from 'imp/std'
import { chart, list, table } from 'imp/std/data'
import { codeBlock, emptyState } from 'imp/std/display'
import { notify } from 'imp/std/feedback'
import { codeEditor, comboBox, form, select, submitForm, textField } from 'imp/std/inputs'
import { flex, stack, tabs } from 'imp/std/layout'
import { luPlay, luPlus, luSave, luSearch, luTrash2, luX } from 'imp/icons'
import { downloadText, problemsOf, runQuery, serversParam } from '../lib/api.js'
import { formatCount, formatMeasure, measureLabel } from '../lib/format.js'
import { BASE_DIMENSIONS, COMMON_MEASURES } from '../lib/measures.js'
import {
  DEFAULT_DRAFT,
  draftToQuery,
  EXAMPLES,
  parseQueryText,
  queryToDraft,
} from '../lib/query-draft.js'
import { cliCommand, labelOf, resultChart, toCsv } from '../lib/rows.js'
import { useScope } from '../lib/scope.js'
import { readStored, writeStored } from '../lib/storage.js'
import { page, reportCard, reportError, reportLoading, screenHeader } from '../parts/report.js'
import { scopeBar } from '../parts/scope-bar.js'

const DRAFT_KEY = 'imp-aly.console.draft'

const SAVED_KEY = 'imp-aly.console.queries'

const ROW_KEY = '#row'

const segmentsOf = (catalog, app) =>
  [
    ...new Set(
      (catalog?.apps ?? []).filter(({ name }) => name === app).flatMap(({ segments }) => segments),
    ),
  ].sort()

const pretty = (query) => JSON.stringify(query, null, 2)

const draftKeeper = component('aly-draft-keeper', {
  setup: (self, draft) => {
    useState(self, 'imp.form').watch(self, (values) => {
      if (values) draft.set(values)
    })
    return []
  },
})

const filterRows = component('aly-filter-rows', {
  styles: `
    :host { display: block; }
    .rows { display: flex; flex-direction: column; gap: var(--imp-space-2, 8px); }
    .row {
      display: grid;
      grid-template-columns: minmax(8rem, 12rem) minmax(0, 1fr) auto;
      gap: var(--imp-space-2, 8px);
      align-items: start;
    }
  `,
  setup: (self, { fields, searchValues }) => {
    const values = useState(self, 'imp.form')
    const count = computed([values], (current) => current?.filters?.length ?? 0)
    const remove = (index) =>
      values.set((current) => ({
        ...current,
        filters: current.filters.filter((_, position) => position !== index),
      }))
    const add = () =>
      values.set((current) => ({
        ...current,
        filters: [...(current?.filters ?? []), { field: 'type', values: [] }],
      }))
    return div(
      { class: 'rows' },
      text({ size: 'sm', weight: 'bold' }, 'Filters'),
      count.view((total) =>
        total
          ? Array.from({ length: total }, (_, index) =>
            div(
              { class: 'row' },
              select({ field: `filters.${index}.field`, ariaLabel: 'Field', options: fields }),
              comboBox({
                field: `filters.${index}.values`,
                ariaLabel: 'Values',
                multiple: true,
                custom: true,
                placeholder: 'Type a value, then press Enter',
                onSearch: (typed, { signal }) =>
                  searchValues(values.get()?.filters?.[index]?.field, typed, signal),
              }),
              button(
                {
                  square: true,
                  label: 'Remove the filter',
                  events: { click: () => remove(index) },
                },
                icon(luX),
              ),
            ))
          : text({ size: 'sm', tone: 'secondary' }, 'No filter: the query counts all the records.')
      ),
      div(
        button(
          { variant: 'ghost', size: 'sm', events: { click: add } },
          icon(luPlus),
          'Add a filter',
        ),
      ),
    )
  },
})

const exploreResult = component('aly-explore-result', {
  loading: () => reportLoading(),
  setup: async (self, { scope, query }) => {
    const api = useHttpClient(self, 'aly.api')
    const answer = await runQuery(api, scope, query)
    const full = { app: scope.app, from: scope.from, to: scope.to, ...query }
    const groupBy = full.groupBy ?? []
    const measures = full.measures ?? ['records']
    const fields = [...groupBy, ...measures]
    const rows = answer.rows.map((row, index) => ({ [ROW_KEY]: index, ...row }))
    const picture = resultChart({ rows: answer.rows, groupBy, measures })
    const fileName = `${full.app}-${answer.from}-${answer.to}`
    const problems = problemsOf([answer])
    return stack(
      { gap: 4 },
      ...problems.failed.map(({ server, reason }) =>
        text({ size: 'sm', tone: 'secondary' }, `${server} did not answer: ${reason}`)
      ),
      ...problems.warnings.map((warning) => text({ size: 'sm', tone: 'secondary' }, warning)),
      flex(
        { wrap: true, verticalAlign: 'center', horizontalAlign: 'justify' },
        text(
          { size: 'sm', tone: 'secondary' },
          `${formatCount(rows.length)} rows${
            answer.truncated ? ' - the limit cut the rows' : ''
          }, ${formatCount(answer.days)} days, ${formatCount(answer.scanned)} records read, ${
            formatCount(answer.matched)
          } matched.`,
        ),
        flex(
          { gap: 2 },
          button(
            {
              size: 'sm',
              events: {
                click: () =>
                  downloadText(`${fileName}.csv`, toCsv(fields, answer.rows), 'text/csv'),
              },
            },
            'CSV',
          ),
          button(
            {
              size: 'sm',
              events: {
                click: () => downloadText(`${fileName}.json`, pretty(answer), 'application/json'),
              },
            },
            'JSON',
          ),
        ),
      ),
      tabs({
        label: 'The result',
        items: [
          {
            id: 'table',
            label: 'Table',
            content: table({
              label: 'The rows of the result',
              rowKey: ROW_KEY,
              rows,
              columns: fields.map((field) =>
                measures.includes(field)
                  ? {
                    key: field,
                    label: field,
                    align: 'end',
                    sortable: true,
                    render: (row) => formatMeasure(field, row[field]),
                  }
                  : {
                    key: field,
                    label: field,
                    sortable: true,
                    render: (row) => labelOf(row[field]),
                  }
              ),
            }),
          },
          {
            id: 'chart',
            label: 'Chart',
            content: picture
              ? chart({
                type: picture.type,
                label: measureLabel(picture.measure),
                labels: picture.labels,
                series: picture.series,
                format: (value) => formatMeasure(picture.measure, value),
              })
              : emptyState({ variant: 'noResults' }),
          },
          {
            id: 'servers',
            label: 'Servers',
            content: table({
              label: 'The servers that answered',
              rowKey: 'server',
              rows: [
                ...answer.servers,
                ...answer.failedServers.map(({ server, reason }) => ({ server, failed: reason })),
              ],
              columns: [
                { key: 'server', label: 'Server' },
                { key: 'days', label: 'Days', align: 'end' },
                { key: 'summaryDays', label: 'From summaries', align: 'end' },
                { key: 'scanned', label: 'Read', align: 'end' },
                { key: 'matched', label: 'Matched', align: 'end' },
                { key: 'failed', label: 'Error' },
              ],
            }),
          },
          {
            id: 'skipped',
            label: `Skipped days (${answer.skippedDays.length})`,
            disabled: !answer.skippedDays.length,
            content: table({
              label: 'The days that the query cannot read',
              rowKey: ROW_KEY,
              rows: answer.skippedDays.map((entry, index) => ({ [ROW_KEY]: index, ...entry })),
              columns: [
                { key: 'server', label: 'Server' },
                { key: 'day', label: 'Day' },
                { key: 'reason', label: 'Reason' },
              ],
            }),
          },
          {
            id: 'cli',
            label: 'CLI',
            content: stack(
              { gap: 2 },
              text({ size: 'sm', tone: 'secondary' }, 'Run the same query in a terminal:'),
              codeBlock({ language: 'bash', code: cliCommand(full, scope.servers) }),
            ),
          },
        ],
      }),
    )
  },
  error: (self, error) => reportError(error),
})

const savedList = (saved, load) =>
  saved.view((items) =>
    items.length
      ? list({
        label: 'Saved queries',
        items: items.map(({ id, name, query }) => ({
          id,
          title: name,
          description: JSON.stringify(query),
        })),
        events: {
          select: (event) => load(items.find(({ id }) => id === event.detail.id)?.query),
        },
        actions: (item) =>
          button(
            {
              square: true,
              size: 'sm',
              variant: 'ghost',
              label: `Delete ${item.title}`,
              events: {
                click: () => saved.set((current) => current.filter(({ id }) => id !== item.id)),
              },
            },
            icon(luTrash2),
          ),
      })
      : text(
        { size: 'sm', tone: 'secondary' },
        'Save a query to run it again later. The console keeps it in this browser.',
      )
  )

export const exploreScreen = component('aly-explore', {
  setup: (self) => {
    const api = useHttpClient(self, 'aly.api')
    const scope = useScope(self)
    const catalog = useState(self, 'aly.catalog')
    const app = useState(self, 'aly.scope.app')
    const storedDraft = readStored(DRAFT_KEY, null)
    const draft = initState(
      self,
      'aly.explore.draft',
      storedDraft && typeof storedDraft === 'object' ? storedDraft : DEFAULT_DRAFT,
    )
    const saved = initState(
      self,
      'aly.explore.saved',
      Array.isArray(readStored(SAVED_KEY, [])) ? readStored(SAVED_KEY, []) : [],
    )
    const json = initState(self, 'aly.explore.json', pretty(draftToQuery(draft.get())))
    const run = initState(self, 'aly.explore.run', null)
    const version = initState(self, 'aly.explore.version', 0)
    const saveName = initState(self, 'aly.explore.name', '')
    const segments = computed([catalog, app], segmentsOf)
    draft.watch(self, (value) => writeStored(DRAFT_KEY, value))
    saved.watch(self, (value) => writeStored(SAVED_KEY, value))

    const currentDraft = () => draft.get()
    const start = (query) => run.set((current) => ({ query, count: (current?.count ?? 0) + 1 }))
    const load = (query) => {
      if (!query) return
      draft.set(queryToDraft(query))
      json.set(pretty(query))
      version.set((value) => value + 1)
      start(query)
    }
    const runJson = () => {
      try {
        const query = parseQueryText(json.get())
        start(query)
      } catch (error) {
        notify({ kind: 'error', title: 'The query did not run', description: error.message })
      }
    }
    const save = () => {
      const name = saveName.get().trim()
      if (!name) {
        notify({ kind: 'warning', title: 'Give the query a name first' })
        return
      }
      const query = draftToQuery(draft.get())
      saved.set((current) => [
        ...current.filter((entry) => entry.name !== name),
        { id: crypto.randomUUID(), name, query },
      ])
      saveName.set('')
      notify({ kind: 'success', title: `Saved the query "${name}"` })
    }
    const cache = new Map()
    const searchValues = async (field, typed, signal) => {
      const current = scope.get()
      if (!field || !current.app) return []
      const key = JSON.stringify([field, current.app, current.from, current.to, current.servers])
      if (!cache.has(key)) {
        cache.set(
          key,
          api.post('/query', {
            query: { servers: serversParam(current.servers) },
            body: {
              app: current.app,
              from: current.from,
              to: current.to,
              groupBy: [field],
              limit: 300,
            },
            signal,
          }).then((answer) => answer.rows.map((row) => labelOf(row[field]))).catch((error) => {
            cache.delete(key)
            throw error
          }),
        )
      }
      const found = await cache.get(key)
      const needle = typed.toLowerCase()
      return found.filter((value) => value.toLowerCase().includes(needle)).slice(0, 40)
    }

    const builder = computed([segments, version], (names) => names).view((names) => {
      const dimensions = ['day', ...BASE_DIMENSIONS, ...names]
      return form(
        {
          initialValues: currentDraft(),
          onSubmit: (values) => {
            const query = draftToQuery(values)
            json.set(pretty(query))
            start(query)
          },
        },
        draftKeeper(draft),
        comboBox({
          field: 'groupBy',
          label: 'Group by',
          multiple: true,
          options: dimensions,
          help: 'Up to 8 fields. "day" puts the rows on a time line.',
        }),
        comboBox({
          field: 'measures',
          label: 'Measures',
          multiple: true,
          custom: true,
          options: COMMON_MEASURES,
          required: true,
          help: 'Type any readyMs.p<1-99> or readyMs.under:<ms>, then press Enter.',
        }),
        filterRows({ fields: BASE_DIMENSIONS.concat(names), searchValues }),
        flex(
          { wrap: true, verticalAlign: 'bottom' },
          textField({ field: 'limit', label: 'Rows', type: 'number', min: 1, max: 100000 }),
          button({ variant: 'primary', events: { click: submitForm } }, icon(luPlay), 'Run'),
          textField({ value: saveName, ariaLabel: 'Name of the query', placeholder: 'Name' }),
          button({ events: { click: save } }, icon(luSave), 'Save'),
        ),
      )
    })

    return page(
      stack(
        { gap: 5 },
        screenHeader(
          'Explore',
          'Build any query of the app. The servers, the app and the days come from the bar.',
        ),
        scopeBar(),
        reportCard(
          {
            title: 'Query',
            actions: menuButton(
              {
                trigger: 'arrow',
                size: 'sm',
                items: EXAMPLES.map(({ id, label, query }) => ({
                  id,
                  label,
                  onClick: () => load(query),
                })),
              },
              'Examples',
            ),
          },
          tabs({
            label: 'How to write the query',
            items: [
              { id: 'builder', label: 'Builder', content: builder },
              {
                id: 'json',
                label: 'JSON',
                content: stack(
                  { gap: 3 },
                  codeEditor({
                    value: json,
                    label: 'The query as JSON',
                    language: 'json',
                    rows: 12,
                    help: 'A field here wins over the bar, such as "from" or "app".',
                  }),
                  flex(
                    button({ variant: 'primary', events: { click: runJson } }, icon(luPlay), 'Run'),
                  ),
                ),
              },
            ],
          }),
        ),
        reportCard(
          { title: 'Result' },
          computed([scope, run], (current, last) => ({ current, last })).view(
            ({ current, last }) => {
              if (!last) {
                return emptyState({
                  icon: luSearch,
                  title: 'No query yet',
                  description: 'Build a query, or choose an example, then run it.',
                })
              }
              if (!current.app) {
                return emptyState({
                  title: 'Choose an app',
                  description: 'The bar above has no app.',
                })
              }
              return exploreResult({ scope: current, query: last.query })
            },
          ),
        ),
        reportCard({ title: 'Saved queries' }, savedList(saved, load)),
      ),
    )
  },
})
