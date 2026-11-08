import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { computed, initState, useState } from 'imp/state'
import { button, icon, menuButton, text } from 'imp/std'
import { table } from 'imp/std/data'
import { descriptionList, emptyState, tag } from 'imp/std/display'
import { notice, notify } from 'imp/std/feedback'
import { comboBox, form, FormError, submitForm, textField } from 'imp/std/inputs'
import { dialog, drawer, flex, stack } from 'imp/std/layout'
import { luPlus } from 'imp/icons'
import { messageOf } from '../lib/api.js'
import { knownSegments, registryRows } from '../lib/catalog.js'
import { formatCount, formatDateTime } from '../lib/format.js'
import {
  originProblem,
  refreshApp,
  registerApp,
  registerBody,
  removeApp,
  removeQuestion,
  segmentProblem,
  segmentsNote,
} from '../lib/registry.js'
import {
  catalogNotice,
  failureText,
  page,
  reportCard,
  screenHeader,
  wide,
} from '../parts/report.js'
import { scopeBar } from '../parts/scope-bar.js'

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

const reportFailures = (title, failedServers) => {
  if (failedServers?.length) {
    notify({ kind: 'warning', title, description: failureText(failedServers), duration: 0 })
  }
}

const BUILD_FILE = 'app-analytics.json'

const serverChoice = (names) =>
  names.length > 1
    ? comboBox({
        field: 'servers',
        label: 'Servers',
        multiple: true,
        required: true,
        options: names,
        help: 'The servers that accept the records of the app.',
        validate: (value) => (value?.length ? null : 'Choose one server or more.'),
      })
    : text({ size: 'sm', tone: 'secondary' }, `The console registers the app on ${names[0]}.`)

const registerForm = component('aly-register-form', {
  setup: (self, { serverNames, segments: known, onDone }) => {
    const api = useHttpClient(self, 'aly.api')
    return form(
      {
        initialValues: {
          name: '',
          appUrl: '',
          segments: [],
          origins: [],
          servers: serverNames.length === 1 ? serverNames : [],
        },
        onSubmit: async (values) => {
          let answer
          try {
            answer = await registerApp(api, values.servers, values.name, registerBody(values))
          } catch (error) {
            throw new FormError(messageOf(error), { cause: error })
          }
          const [first] = answer.apps
          notify({
            kind: 'success',
            title: `Registered ${values.name}`,
            description: `${first.pages.length} pages, ${first.zones.length} zones, ${first.outcomes.length} outcomes. Send records to /collect/${values.name}.`,
          })
          reportFailures(`${values.name} is not registered on every server`, answer.failedServers)
          onDone()
        },
      },
      textField({
        field: 'name',
        label: 'Name',
        required: true,
        placeholder: 'myapp',
        validate: (value) =>
          APP_NAME.test(value ?? '') ? null : 'Use 1 to 63 lowercase letters, digits and "-".',
      }),
      textField({
        field: 'appUrl',
        label: 'URL of the app',
        type: 'url',
        required: true,
        placeholder: 'https://myapp.example/',
        help: `The folder where the build is served. The server reads ${BUILD_FILE} there, and again every 10 minutes.`,
      }),
      comboBox({
        field: 'segments',
        label: 'Segments',
        multiple: true,
        custom: true,
        options: known.map(({ segment }) => segment),
        placeholder: 'plan, role ...',
        help: 'The extra fields that the records can carry. Choose a segment from the list, or type a name and press Enter.',
        validate: segmentProblem,
      }),
      text({ size: 'sm', tone: 'secondary' }, segmentsNote(known)),
      comboBox({
        field: 'origins',
        label: 'Origins',
        multiple: true,
        custom: true,
        options: [],
        placeholder: 'https://myapp.example ...',
        help: 'The browser origins of the pages of the app. The server refuses records from the pages of other origins. With a URL and no origin, the server takes the origin of the URL. Type an origin and press Enter.',
        validate: originProblem,
      }),
      serverChoice(serverNames),
      flex(button({ variant: 'primary', events: { click: submitForm } }, 'Register')),
    )
  },
})

const appDetails = (entries) =>
  stack(
    { gap: 5 },
    ...entries.map((entry) =>
      stack(
        { gap: 3 },
        text({ weight: 'bold' }, entry.server),
        entry.buildError
          ? notice({ kind: 'error', title: 'The server cannot read the build' }, entry.buildError)
          : null,
        descriptionList({
          items: [
            { term: 'Pages', details: formatCount(entry.pages.length) },
            { term: 'Zones', details: formatCount(entry.zones.length) },
            { term: 'Outcomes', details: formatCount(entry.outcomes.length) },
            { term: 'Segments', details: entry.segments.join(', ') || '-' },
            { term: 'Origins', details: (entry.origins ?? []).join(', ') || '-' },
            { term: 'Files of the build', details: entry.appUrl },
            { term: 'Files read at', details: formatDateTime(entry.buildUpdatedAt) },
            { term: 'Registered at', details: formatDateTime(entry.createdAt) },
            { term: 'Accepted records', details: formatCount(entry.accepted) },
            { term: 'Rejected records', details: formatCount(entry.rejected) },
          ],
        }),
        Object.keys(entry.rejections ?? {}).length
          ? table({
              label: `Why ${entry.server} rejected records`,
              rowKey: 'problem',
              rows: Object.entries(entry.rejections)
                .map(([problem, count]) => ({ problem, count }))
                .sort((a, b) => b.count - a.count),
              columns: [
                { key: 'problem', label: 'Problem' },
                {
                  key: 'count',
                  label: 'Records',
                  align: 'end',
                  render: (row) => formatCount(row.count),
                },
              ],
            })
          : text({ size: 'sm', tone: 'secondary' }, 'No record was rejected since the start.'),
      ),
    ),
  )

const filesTag = (row) =>
  row.buildErrors
    ? tag({ color: 'red', dot: true }, 'Cannot read')
    : tag({ color: 'green', dot: true }, 'Read')

const countColumn = (key, label) => ({
  key,
  label,
  align: 'end',
  sortable: true,
  sortValue: (row) => row[key].length,
  render: (row) => formatCount(row[key].length),
})

export const registryScreen = component('aly-registry', {
  setup: (self) => {
    const api = useHttpClient(self, 'aly.api')
    const catalog = useState(self, 'aly.catalog')
    const revision = useState(self, 'aly.revision')
    const adding = initState(self, 'aly.registry.adding', false)
    const shown = initState(self, 'aly.registry.shown', null)
    const removing = initState(self, 'aly.registry.removing', null)
    const busy = initState(self, 'aly.registry.busy', false)
    const showOpen = initState(self, 'aly.registry.showOpen', false)
    const removeOpen = initState(self, 'aly.registry.removeOpen', false)
    const rows = computed([catalog], registryRows)
    const show = (name) => {
      shown.set(name)
      showOpen.set(true)
    }
    const ask = (row) => {
      removing.set({ name: row.name, servers: row.servers })
      removeOpen.set(true)
    }
    const reload = () => revision.set((value) => value + 1)

    const refresh = async (row) => {
      const { name } = row
      try {
        const answer = await refreshApp(api, row)
        const errors = answer.apps.filter((entry) => entry.buildError)
        if (errors.length) {
          notify({
            kind: 'error',
            title: `The files of ${name} could not be read`,
            description: errors.map((entry) => `${entry.server}: ${entry.buildError}`).join(' '),
            duration: 0,
          })
        } else notify({ kind: 'success', title: `Read the files of ${name} again` })
        reportFailures(`The files of ${name} were not read on every server`, answer.failedServers)
      } catch (error) {
        notify({
          kind: 'error',
          title: `The files of ${name} were not read`,
          description: messageOf(error),
        })
      }
      reload()
    }

    const remove = async () => {
      const row = removing.get()
      busy.set(true)
      try {
        const answer = await removeApp(api, row)
        notify({
          kind: 'success',
          title: `Removed ${row.name} from ${answer.apps.map(({ server }) => server).join(', ')}`,
          description: 'The stored data stays until the retention removes it.',
        })
        reportFailures(`${row.name} is not removed from every server`, answer.failedServers)
      } catch (error) {
        notify({
          kind: 'error',
          title: `${row.name} was not removed`,
          description: messageOf(error),
        })
      }
      busy.set(false)
      removeOpen.set(false)
      reload()
    }

    const appsTable = (value, list) => {
      if (value === undefined) return text({ tone: 'secondary' }, 'Loading the apps...')
      if (value.error) return notice({ kind: 'error', title: 'The apps did not load' }, value.error)
      if (!list.length) {
        return emptyState({
          title: 'No app is registered',
          description: 'Register an app. Then the app can send records to /collect/<app>.',
        })
      }
      return table({
        label: 'Registered apps',
        rows: list,
        columns: [
          {
            key: 'name',
            label: 'App',
            sortable: true,
            render: (row) =>
              button({ variant: 'link', events: { click: () => show(row.name) } }, row.name),
          },
          {
            key: 'servers',
            label: 'Servers',
            sortable: true,
            sortValue: (row) => row.servers.join(', '),
            render: (row) => row.servers.join(', '),
          },
          countColumn('pages', 'Pages'),
          countColumn('zones', 'Zones'),
          countColumn('outcomes', 'Outcomes'),
          {
            key: 'segments',
            label: 'Segments',
            render: (row) => row.segments.join(', ') || '-',
          },
          {
            key: 'accepted',
            label: 'Accepted',
            align: 'end',
            sortable: true,
            render: (row) => formatCount(row.accepted),
          },
          {
            key: 'rejected',
            label: 'Rejected',
            align: 'end',
            sortable: true,
            render: (row) => formatCount(row.rejected),
          },
          { key: 'buildErrors', label: 'Files', render: filesTag },
          {
            key: 'actions',
            label: 'Actions',
            align: 'end',
            render: (row) =>
              menuButton({
                label: `Actions for ${row.name}`,
                items: [
                  { id: 'show', label: 'Details', onClick: () => show(row.name) },
                  { id: 'refresh', label: 'Read the files again', onClick: () => refresh(row) },
                  { id: 'remove', label: 'Remove', onClick: () => ask(row) },
                ],
              }),
          },
        ],
      })
    }

    return page(
      stack(
        { gap: 5 },
        flex(
          { horizontalAlign: 'justify', verticalAlign: 'center', wrap: true },
          screenHeader({
            title: 'Registered apps',
            description:
              'The apps that the servers accept records for, one row per app. Each app has its build file and segments on each of its servers.',
          }),
          catalog.view((value) =>
            value?.servers?.servers.length
              ? button(
                  { variant: 'primary', events: { click: () => adding.set(true) } },
                  icon(luPlus),
                  'Register an app',
                )
              : null,
          ),
        ),
        scopeBar({ period: false }),
        catalogNotice(catalog),
        reportCard(
          { title: 'Registered apps' },
          computed([catalog, rows], (value, list) => ({ value, list })).view(({ value, list }) =>
            appsTable(value, list),
          ),
        ),
        dialog(
          { title: 'Register an app', open: adding },
          computed([adding, catalog], (open, value) => ({
            open,
            names: (value?.servers?.servers ?? []).map(({ name }) => name),
            segments: knownSegments(value),
          })).view(({ open, names, segments }) =>
            open && names.length
              ? registerForm({
                  serverNames: names,
                  segments,
                  onDone: () => {
                    adding.set(false)
                    reload()
                  },
                })
              : null,
          ),
        ),
        wide(
          drawer(
            { title: computed([shown], (name) => name ?? 'App'), open: showOpen },
            computed([catalog, shown], (value, name) =>
              (value?.apps ?? []).filter((entry) => entry.name === name),
            ).view((entries) => (entries.length ? appDetails(entries) : null)),
          ),
        ),
        dialog(
          { title: computed([removing], removeQuestion), open: removeOpen },
          stack(
            { gap: 4 },
            text(
              'These servers stop accepting the records of the app. The stored data stays until the retention removes it. You can register the app again.',
            ),
            flex(
              { horizontalAlign: 'end' },
              button(
                { variant: 'ghost', events: { click: () => removeOpen.set(false) } },
                'Cancel',
              ),
              button({ variant: 'danger', loading: busy, events: { click: remove } }, 'Remove'),
            ),
          ),
        ),
      ),
    )
  },
})
