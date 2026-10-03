import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { computed, initState, useState } from 'imp/state'
import { button, icon, menuButton, text } from 'imp/std'
import { table } from 'imp/std/data'
import { descriptionList, emptyState, tag } from 'imp/std/display'
import { notice, notify } from 'imp/std/feedback'
import {
  comboBox,
  fileUpload,
  form,
  FormError,
  segmented,
  submitForm,
  textField,
} from 'imp/std/inputs'
import { dialog, drawer, flex, stack } from 'imp/std/layout'
import { luPlus } from 'imp/icons'
import { messageOf, serversParam } from '../lib/api.js'
import { formatCount, formatDateTime } from '../lib/format.js'
import { page, reportCard, screenHeader, wide } from '../parts/report.js'
import { scopeBar } from '../parts/scope-bar.js'

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

const SOURCES = [
  { value: 'url', label: 'URL' },
  { value: 'file', label: 'File' },
  { value: 'text', label: 'Text' },
]

const failureText = (failedServers) =>
  failedServers.map(({ server, reason }) => `${server}: ${reason}`).join(' ')

const reportFailures = (title, failedServers) => {
  if (failedServers?.length) {
    notify({ kind: 'warning', title, description: failureText(failedServers), duration: 0 })
  }
}

const sourceFields = (source, setFiles) => {
  if (source === 'url') {
    return textField({
      field: 'mapUrl',
      label: 'URL of app-map.txt',
      type: 'url',
      required: true,
      placeholder: 'https://myapp.example/app-map.txt',
      help: 'The server reads the map again every 10 minutes.',
    })
  }
  if (source === 'file') {
    return fileUpload({
      field: 'files',
      label: 'app-map.txt',
      accept: '.txt,text/plain',
      required: true,
      onFiles: setFiles,
      help: 'imp build writes this file next to the app.',
    })
  }
  return textField({
    field: 'map',
    label: 'Route patterns',
    rows: 6,
    required: true,
    placeholder: '/\n/invoices\n/invoices/:id',
    help: 'One route pattern on each line.',
  })
}

const registerForm = component('aly-register-form', {
  setup: (self, { onDone }) => {
    const api = useHttpClient(self, 'aly.api')
    const servers = useState(self, 'aly.scope.servers')
    let files = []
    const source = initState(self, 'aly.register.source', 'url')
    return form(
      {
        initialValues: { name: '', mapUrl: '', map: '', files: [], segments: [] },
        onSubmit: async (values) => {
          const body = { segments: values.segments }
          if (source.get() === 'url') body.mapUrl = values.mapUrl
          else if (source.get() === 'file') body.map = await files[0].text()
          else body.map = values.map
          let answer
          try {
            answer = await api.put(`/apps/${encodeURIComponent(values.name)}`, {
              query: { servers: serversParam(servers.get()) },
              body,
            })
          } catch (error) {
            throw new FormError(messageOf(error), { cause: error })
          }
          const [first] = answer.apps
          notify({
            kind: 'success',
            title: `Registered ${values.name}`,
            description: `${first.pages} pages. Send records to /collect/${values.name}.`,
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
      segmented({ label: 'The app map comes from', value: source, options: SOURCES }),
      source.view((value) => sourceFields(value, (chosen) => (files = chosen))),
      comboBox({
        field: 'segments',
        label: 'Segments',
        multiple: true,
        custom: true,
        placeholder: 'plan, role ...',
        help: 'The extra fields that the records can carry. Type a name, then press Enter.',
      }),
      text(
        { size: 'sm', tone: 'secondary' },
        servers.get().length
          ? `The console registers the app on: ${servers.get().join(', ')}.`
          : 'The console registers the app on the default server.',
      ),
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
        entries.length > 1 ? text({ weight: 'bold' }, entry.server) : null,
        entry.mapError
          ? notice({ kind: 'error', title: 'The server cannot read the app map' }, entry.mapError)
          : null,
        descriptionList({
          items: [
            { term: 'Pages', details: formatCount(entry.pages) },
            { term: 'Segments', details: entry.segments.join(', ') || '-' },
            { term: 'App map', details: entry.mapUrl ?? 'uploaded' },
            { term: 'Map read at', details: formatDateTime(entry.mapUpdatedAt) },
            { term: 'Registered at', details: formatDateTime(entry.createdAt) },
            { term: 'Accepted records', details: formatCount(entry.accepted) },
            { term: 'Rejected records', details: formatCount(entry.rejected) },
          ],
        }),
        Object.keys(entry.rejections ?? {}).length
          ? table({
            label: `Why ${entry.server} rejected records`,
            rowKey: 'problem',
            rows: Object.entries(entry.rejections).map(([problem, count]) => ({ problem, count }))
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
      )
    ),
  )

export const appsScreen = component('aly-apps', {
  setup: (self) => {
    const api = useHttpClient(self, 'aly.api')
    const catalog = useState(self, 'aly.catalog')
    const servers = useState(self, 'aly.scope.servers')
    const revision = useState(self, 'aly.revision')
    const adding = initState(self, 'aly.apps.adding', false)
    const shown = initState(self, 'aly.apps.shown', null)
    const removing = initState(self, 'aly.apps.removing', null)
    const busy = initState(self, 'aly.apps.busy', false)
    const showOpen = initState(self, 'aly.apps.showOpen', false)
    const removeOpen = initState(self, 'aly.apps.removeOpen', false)
    const show = (name) => {
      shown.set(name)
      showOpen.set(true)
    }
    const ask = (name) => {
      removing.set(name)
      removeOpen.set(true)
    }
    const reload = () => revision.set((value) => value + 1)
    const query = () => ({ servers: serversParam(servers.get()) })

    const refresh = async (name) => {
      try {
        const answer = await api.post(`/apps/${encodeURIComponent(name)}/refresh`, {
          query: query(),
        })
        const errors = answer.apps.filter((entry) => entry.mapError)
        if (errors.length) {
          notify({
            kind: 'error',
            title: `The map of ${name} could not be read`,
            description: errors.map((entry) => `${entry.server}: ${entry.mapError}`).join(' '),
            duration: 0,
          })
        } else notify({ kind: 'success', title: `Read the map of ${name} again` })
        reportFailures(`The map of ${name} was not read on every server`, answer.failedServers)
      } catch (error) {
        notify({
          kind: 'error',
          title: `The map of ${name} was not read`,
          description: messageOf(error),
        })
      }
      reload()
    }

    const remove = async () => {
      const name = removing.get()
      busy.set(true)
      try {
        const answer = await api.delete(`/apps/${encodeURIComponent(name)}`, { query: query() })
        notify({
          kind: 'success',
          title: `Removed ${name}`,
          description: 'The stored data stays until the retention removes it.',
        })
        reportFailures(`${name} is not removed from every server`, answer.failedServers)
      } catch (error) {
        notify({ kind: 'error', title: `${name} was not removed`, description: messageOf(error) })
      }
      busy.set(false)
      removeOpen.set(false)
      reload()
    }

    const appsTable = (value) => {
      if (value === undefined) return text({ tone: 'secondary' }, 'Loading the apps...')
      if (value.error) return notice({ kind: 'error', title: 'The apps did not load' }, value.error)
      const many = value.chosen.length > 1
      const rows = value.apps.map((entry) => ({ ...entry, id: `${entry.server} ${entry.name}` }))
      return stack(
        { gap: 3 },
        value.failedServers.length
          ? notice(
            { kind: 'warning', title: 'Some servers did not answer' },
            failureText(value.failedServers),
          )
          : null,
        rows.length
          ? table({
            label: 'Registered apps',
            rows,
            columns: [
              ...(many ? [{ key: 'server', label: 'Server', sortable: true }] : []),
              {
                key: 'name',
                label: 'App',
                sortable: true,
                render: (row) =>
                  button(
                    { variant: 'link', events: { click: () => show(row.name) } },
                    row.name,
                  ),
              },
              { key: 'pages', label: 'Pages', align: 'end', sortable: true },
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
              {
                key: 'mapError',
                label: 'Map',
                render: (row) =>
                  row.mapError
                    ? tag({ color: 'red', dot: true }, 'Cannot read')
                    : tag({ color: 'green', dot: true }, row.mapUrl ? 'From URL' : 'Uploaded'),
              },
              {
                key: 'actions',
                label: 'Actions',
                align: 'end',
                render: (row) =>
                  menuButton({
                    label: `Actions for ${row.name}`,
                    items: [
                      { id: 'show', label: 'Details', onClick: () => show(row.name) },
                      {
                        id: 'refresh',
                        label: 'Read the map again',
                        disabled: !row.mapUrl,
                        onClick: () => refresh(row.name),
                      },
                      { id: 'remove', label: 'Remove', onClick: () => ask(row.name) },
                    ],
                  }),
              },
            ],
          })
          : emptyState({
            title: 'No app is registered',
            description: 'Register an app. Then the app can send records to /collect/<app>.',
          }),
      )
    }

    return page(
      stack(
        { gap: 5 },
        flex(
          { horizontalAlign: 'justify', verticalAlign: 'top', wrap: true },
          screenHeader(
            'Apps',
            'The apps that the servers accept records for. Each app has an app map and segments.',
          ),
          button(
            { variant: 'primary', events: { click: () => adding.set(true) } },
            icon(luPlus),
            'Register an app',
          ),
        ),
        scopeBar({ reports: false }),
        reportCard({ title: 'Registered apps' }, catalog.view(appsTable)),
        dialog(
          { title: 'Register an app', open: adding },
          adding.view((open) => (open
            ? registerForm({
              onDone: () => {
                adding.set(false)
                reload()
              },
            })
            : null)
          ),
        ),
        wide(drawer(
          { title: computed([shown], (name) => name ?? 'App'), open: showOpen },
          computed(
            [catalog, shown],
            (value, name) => (value?.apps ?? []).filter((entry) => entry.name === name),
          ).view((entries) => (entries.length ? appDetails(entries) : null)),
        )),
        dialog(
          {
            title: computed([removing], (name) => `Remove ${name ?? 'the app'}?`),
            open: removeOpen,
          },
          stack(
            { gap: 4 },
            text(
              'The servers stop accepting the records of the app. The stored data stays until the retention removes it. You can register the app again.',
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
