import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { computed, initState, useState } from 'imp/state'
import { button, icon, menuButton, text } from 'imp/std'
import { table } from 'imp/std/data'
import { card, descriptionList, emptyState, tag } from 'imp/std/display'
import { notice, notify, progress, skeleton } from 'imp/std/feedback'
import { form, FormError, submitForm, textField } from 'imp/std/inputs'
import { dialog, flex, stack } from 'imp/std/layout'
import { luPlus, luServer } from 'imp/icons'
import { messageOf } from '../lib/api.js'
import { statusOf } from '../lib/client.js'
import { formatBytes, formatCount, formatDateTime } from '../lib/format.js'
import { parseServerUrl, removeServer, saveServer, SERVER_NAME, useServer } from '../lib/vault.js'
import { columns, page, reportCard, screenHeader } from '../parts/report.js'

const linkedServer = () => {
  const params = new URLSearchParams(location.hash.slice(1))
  if (!params.has('url')) return null
  history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  return {
    name: params.get('name') ?? '',
    url: params.get('url') ?? '',
    key: params.get('key') ?? '',
  }
}

const storageNotices = (storage) =>
  [
    storage.lastError
      ? notice({ kind: 'error', title: 'The last store failed' }, storage.lastError)
      : null,
    storage.retentionError
      ? notice({ kind: 'warning', title: 'The retention check failed' }, storage.retentionError)
      : null,
    storage.heldDays?.length
      ? notice(
        { kind: 'warning', title: `${storage.heldDays.length} days wait aside` },
        storage.heldDays.map(({ day, error }) => `${day}: ${error}`).join(' '),
      )
      : null,
    storage.unreadableSegments
      ? notice(
        { kind: 'warning', title: 'Some log parts cannot be read' },
        `${storage.unreadableSegments} log parts cannot be read.`,
      )
      : null,
  ].filter(Boolean)

const diskBar = (disk) => {
  if (!disk?.totalBytes) return null
  const share = (disk.freeBytes / disk.totalBytes) * 100
  return progress({
    label: `Free disk space: ${formatBytes(disk.freeBytes)} of ${formatBytes(disk.totalBytes)}`,
    value: Math.round(share * 10) / 10,
    showValue: true,
    color: disk.freeBytes < disk.neededBytes ? 'red' : share < 20 ? 'amber' : 'green',
  })
}

const serverStatus = component('aly-server-status', {
  loading: () => card(skeleton({ lines: 6 })),
  setup: async (self, { name, label }) => {
    const api = useHttpClient(self, 'aly.api')
    const status = await statusOf(api, name)
    const { storage } = status
    return reportCard(
      {
        title: label,
        actions: flex(
          { gap: 2 },
          tag({ color: 'green', dot: true }, 'Answers'),
          tag(status.version),
        ),
      },
      text({ size: 'sm', tone: 'secondary' }, status.url),
      ...storageNotices(storage),
      diskBar(storage.disk),
      descriptionList({
        columns: 2,
        items: [
          { term: 'Version', details: status.version },
          { term: 'Started at', details: formatDateTime(status.startedAt) },
          { term: 'Data folder', details: status.dataDir },
          { term: 'Apps', details: formatCount(status.apps) },
          { term: 'Records stored since the start', details: formatCount(storage.processedRows) },
          { term: 'Last store', details: formatDateTime(storage.lastProcessedAt) },
          { term: 'Log parts that wait', details: formatCount(storage.pendingSegments) },
          {
            term: 'Requests in progress',
            details: `${status.activeRequests.public} public, ${status.activeRequests.admin} admin`,
          },
          { term: 'Addresses in the rate limit', details: formatCount(status.rateLimitedClients) },
        ],
      }),
    )
  },
  error: (self, error, { label }) =>
    reportCard(
      { title: label, actions: tag({ color: 'red', dot: true }, 'No answer') },
      notice({ kind: 'error', title: 'The server did not answer' }, messageOf(error)),
    ),
})

const urlProblem = (value) => {
  try {
    parseServerUrl(value)
    return null
  } catch (error) {
    return error.message
  }
}

const serverForm = component('aly-server-form', {
  setup: (self, { initial, editing, onDone }) => {
    const api = useHttpClient(self, 'aly.api')
    return form(
      {
        initialValues: initial,
        onSubmit: async (values) => {
          let saved
          try {
            saved = await saveServer(values)
          } catch (error) {
            throw new FormError(messageOf(error), { cause: error })
          }
          try {
            const status = await statusOf(api, saved.name)
            notify({
              kind: 'success',
              title: `Saved the server ${saved.name}`,
              description:
                `It answers with imp-aly ${status.version}, and it is the active server now.`,
            })
          } catch (error) {
            notify({
              kind: 'warning',
              title: `Saved the server ${saved.name}, but it did not answer`,
              description: messageOf(error),
              duration: 0,
            })
          }
          onDone()
        },
      },
      textField({
        field: 'name',
        label: 'Name',
        required: true,
        readonly: editing,
        placeholder: 'eu-1',
        validate: (value) =>
          SERVER_NAME.test(value ?? '')
            ? null
            : 'Use up to 63 letters, digits, ".", "_" and "-". Start with a letter or a digit.',
      }),
      textField({
        field: 'url',
        label: 'URL of the admin port',
        type: 'url',
        required: true,
        placeholder: 'https://analytics.myapp.example:2981',
        validate: urlProblem,
      }),
      textField({
        field: 'key',
        label: 'Key',
        type: 'password',
        autocomplete: 'off',
        required: !editing,
        help: editing
          ? 'Empty: keep the saved key.'
          : 'The key of the server, from ~/.secret/imp-aly-key on the server. This browser keeps it, and no script can read it back.',
      }),
      flex(button({ variant: 'primary', events: { click: submitForm } }, 'Save the server')),
    )
  },
})

const EMPTY_SERVER = { name: '', url: '', key: '' }

export const serversScreen = component('aly-servers', {
  setup: (self) => {
    const catalog = useState(self, 'aly.catalog')
    const revision = useState(self, 'aly.revision')
    const scopeServers = useState(self, 'aly.scope.servers')
    const linked = linkedServer()
    const editing = initState(self, 'aly.servers.editing', linked ? { initial: linked } : null)
    const formOpen = initState(self, 'aly.servers.formOpen', linked !== null)
    const removing = initState(self, 'aly.servers.removing', null)
    const removeOpen = initState(self, 'aly.servers.removeOpen', false)
    const saved = computed([catalog], (value) => value?.servers ?? null)
    const reload = () => {
      scopeServers.set((names) => names.filter((name) => name !== removing.get()))
      revision.set((value) => value + 1)
    }
    const openForm = (value) => {
      editing.set(value)
      formOpen.set(true)
    }
    const add = () => openForm({ initial: EMPTY_SERVER })

    const makeActive = async (name) => {
      try {
        await useServer(name)
        if (scopeServers.get().length) scopeServers.set([])
        notify({ kind: 'success', title: `${name} is the active server now` })
      } catch (error) {
        notify({
          kind: 'error',
          title: 'The active server did not change',
          description: messageOf(error),
        })
      }
      reload()
    }

    const remove = async () => {
      const name = removing.get()
      try {
        await removeServer(name)
        notify({ kind: 'success', title: `Removed the server ${name}` })
      } catch (error) {
        notify({ kind: 'error', title: `${name} was not removed`, description: messageOf(error) })
      }
      removeOpen.set(false)
      reload()
    }

    const serverTable = (store) => {
      if (!store) return text({ tone: 'secondary' }, 'Loading the servers...')
      if (!store.servers.length) {
        return emptyState(
          {
            icon: luServer,
            title: 'No server is added',
            description:
              'Add the URL of the admin port of an imp-aly server, and its key. Add more servers to switch between them, or to add up their numbers.',
          },
          button({ variant: 'primary', events: { click: add } }, 'Add a server'),
        )
      }
      return table({
        label: 'Servers',
        rowKey: 'name',
        rows: store.servers,
        columns: [
          {
            key: 'name',
            label: 'Name',
            sortable: true,
            render: (row) =>
              row.name === store.default
                ? flex(
                  { gap: 2, verticalAlign: 'center' },
                  row.name,
                  tag({ color: 'blue', size: 'sm' }, 'active'),
                )
                : row.name,
          },
          { key: 'url', label: 'URL' },
          {
            key: 'actions',
            label: 'Actions',
            align: 'end',
            render: (row) =>
              menuButton({
                label: `Actions for ${row.name}`,
                items: [
                  {
                    id: 'active',
                    label: 'Make it the active server',
                    disabled: row.name === store.default,
                    onClick: () => makeActive(row.name),
                  },
                  {
                    id: 'edit',
                    label: 'Change the URL or the key',
                    onClick: () =>
                      openForm({ initial: { name: row.name, url: row.url, key: '' }, edit: true }),
                  },
                  {
                    id: 'remove',
                    label: 'Remove',
                    onClick: () => {
                      removing.set(row.name)
                      removeOpen.set(true)
                    },
                  },
                ],
              }),
          },
        ],
      })
    }

    const statuses = (store) =>
      store?.servers.length
        ? columns(...store.servers.map(({ name }) => serverStatus({ name, label: name })))
        : null

    return page(
      stack(
        { gap: 5 },
        flex(
          { horizontalAlign: 'justify', verticalAlign: 'center', wrap: true },
          screenHeader({
            title: 'Servers',
            description:
              'The servers of this browser. The reports ask the active server, or the servers that you choose in the bar.',
          }),
          button({ variant: 'primary', events: { click: add } }, icon(luPlus), 'Add a server'),
        ),
        reportCard({ title: 'Servers' }, saved.view(serverTable)),
        saved.view(statuses),
        notice(
          { kind: 'info', title: 'The keys stay in this browser' },
          'The browser keeps each key in a form that no script can read back. The page signs a one-time token for each call, so the key never goes over the network. Anybody who can open this page on this device can use the servers. Lock the device.',
        ),
        dialog(
          {
            title: computed(
              [editing],
              (value) => (value?.edit ? `Change ${value.initial.name}` : 'Add a server'),
            ),
            open: formOpen,
          },
          editing.view((value) =>
            value
              ? serverForm({
                initial: value.initial,
                editing: value.edit === true,
                onDone: () => {
                  formOpen.set(false)
                  reload()
                },
              })
              : null
          ),
        ),
        dialog(
          {
            title: computed([removing], (name) => `Remove ${name ?? 'the server'}?`),
            open: removeOpen,
          },
          stack(
            { gap: 4 },
            text(
              'This browser forgets the server and its key. The server and its data do not change.',
            ),
            flex(
              { horizontalAlign: 'end' },
              button(
                { variant: 'ghost', events: { click: () => removeOpen.set(false) } },
                'Cancel',
              ),
              button({ variant: 'danger', events: { click: remove } }, 'Remove'),
            ),
          ),
        ),
      ),
    )
  },
})
