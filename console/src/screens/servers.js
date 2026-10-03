import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { computed, initState, useState } from 'imp/state'
import { button, icon, menuButton, text } from 'imp/std'
import { table } from 'imp/std/data'
import { card, descriptionList, emptyState, tag } from 'imp/std/display'
import { notice, notify, progress, skeleton } from 'imp/std/feedback'
import { form, FormError, submitForm, textField } from 'imp/std/inputs'
import { dialog, flex, stack } from 'imp/std/layout'
import { luPlus } from 'imp/icons'
import { messageOf } from '../lib/api.js'
import { formatBytes, formatCount, formatDateTime } from '../lib/format.js'
import { columns, page, reportCard, screenHeader } from '../parts/report.js'

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

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
    const status = await api.get('/status', { query: { server: name } })
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

const addForm = component('aly-add-server-form', {
  setup: (self, { onDone }) => {
    const api = useHttpClient(self, 'aly.api')
    return form(
      {
        initialValues: { name: '', url: '', auth: '' },
        onSubmit: async (values) => {
          try {
            await api.post('/servers', { body: values })
          } catch (error) {
            throw new FormError(messageOf(error), { cause: error })
          }
          notify({
            kind: 'success',
            title: `Saved the server ${values.name}`,
            description: 'It is the default server now.',
          })
          onDone()
        },
      },
      textField({
        field: 'name',
        label: 'Name',
        required: true,
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
      }),
      textField({
        field: 'auth',
        label: 'Key',
        type: 'password',
        help:
          'The key, or the path of a file with the key. Empty: ~/.secret/imp-aly-key. The console saves a path, not the key in the file.',
      }),
      flex(button({ variant: 'primary', events: { click: submitForm } }, 'Save the server')),
    )
  },
})

export const serversScreen = component('aly-servers', {
  setup: (self) => {
    const api = useHttpClient(self, 'aly.api')
    const catalog = useState(self, 'aly.catalog')
    const revision = useState(self, 'aly.revision')
    const adding = initState(self, 'aly.servers.adding', false)
    const removing = initState(self, 'aly.servers.removing', null)
    const removeOpen = initState(self, 'aly.servers.removeOpen', false)
    const reload = () => revision.set((value) => value + 1)
    const saved = computed([catalog], (value) => value?.servers ?? null)

    const makeDefault = async (name) => {
      try {
        await api.post(`/servers/${encodeURIComponent(name)}/default`)
        notify({ kind: 'success', title: `${name} is the default server now` })
      } catch (error) {
        notify({
          kind: 'error',
          title: 'The default server did not change',
          description: messageOf(error),
        })
      }
      reload()
    }

    const remove = async () => {
      const name = removing.get()
      try {
        await api.delete(`/servers/${encodeURIComponent(name)}`)
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
            title: 'No server is saved',
            description:
              `The console uses the local server, ${store.localUrl}, with the key in ~/.secret/imp-aly-key.`,
          },
          button(
            { variant: 'primary', events: { click: () => adding.set(true) } },
            'Save a server',
          ),
        )
      }
      return table({
        label: 'Saved servers',
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
                  tag({ color: 'blue', size: 'sm' }, 'default'),
                )
                : row.name,
          },
          { key: 'url', label: 'URL' },
          { key: 'key', label: 'Key' },
          {
            key: 'actions',
            label: 'Actions',
            align: 'end',
            render: (row) =>
              menuButton({
                label: `Actions for ${row.name}`,
                items: [
                  {
                    id: 'default',
                    label: 'Make it the default',
                    disabled: row.name === store.default,
                    onClick: () => makeDefault(row.name),
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

    const statuses = (store) => {
      if (!store) return null
      const targets = store.servers.length
        ? store.servers.map(({ name, url }) => ({ name, label: name, url }))
        : [{ name: undefined, label: 'Local server', url: store.localUrl }]
      return columns(...targets.map((target) => serverStatus(target)))
    }

    return page(
      stack(
        { gap: 5 },
        flex(
          { horizontalAlign: 'justify', verticalAlign: 'top', wrap: true },
          screenHeader(
            'Servers',
            'The servers that this machine saved, with their keys. The list is the same as in imp-aly ls.',
          ),
          button(
            { variant: 'primary', events: { click: () => adding.set(true) } },
            icon(luPlus),
            'Save a server',
          ),
        ),
        reportCard({ title: 'Saved servers' }, saved.view(serverTable)),
        saved.view(statuses),
        dialog(
          { title: 'Save a server', open: adding },
          adding.view((open) =>
            open
              ? addForm({
                onDone: () => {
                  adding.set(false)
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
              'The console and the CLI forget the server. The server and its data do not change.',
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
