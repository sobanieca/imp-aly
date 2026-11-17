import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { computed, initState, useState } from 'imp/state'
import { button, icon, text } from 'imp/std'
import { table } from 'imp/std/data'
import { codeBlock, descriptionList, emptyState, tag } from 'imp/std/display'
import { notice, notify, skeleton } from 'imp/std/feedback'
import { form, FormError, segmented, submitForm, textField } from 'imp/std/inputs'
import { dialog, flex, stack } from 'imp/std/layout'
import { luBot, luPlus } from 'imp/icons'
import { agentCommand, agentKeyBody, DURATIONS, timeLeft } from '../lib/agent-keys.js'
import { messageOf } from '../lib/api.js'
import { addAgentKey, agentKeysOf, removeAgentKey } from '../lib/client.js'
import { formatDateTime } from '../lib/format.js'
import { isAppName } from '../shared/names.js'
import { page, reportCard, screenHeader } from '../parts/report.js'

const ABOUT =
  'An agent key is a temporary key for an AI agent that uses the imp-aly CLI. It has the rights of the key of the server: it can query, register and remove apps, and make and restore backups. It cannot add, list or remove agent keys. It stops after the time that you choose: 1, 4, 8 or 24 hours. A new key of the server removes all agent keys.'

const serverKeys = component('aly-server-agent-keys', {
  loading: () => skeleton({ lines: 3 }),
  setup: async (self, { name, onAdd, onRemove }) => {
    const api = useHttpClient(self, 'aly.api')
    const keys = await agentKeysOf(api, name)
    const add = button(
      { variant: 'primary', events: { click: () => onAdd(name) } },
      icon(luPlus),
      'Add an agent key',
    )
    if (!keys.length) {
      return stack(
        { gap: 3 },
        text({ tone: 'secondary' }, `${name} has no agent key that works now.`),
        flex(add),
      )
    }
    return stack(
      { gap: 3 },
      table({
        label: `Agent keys of ${name}`,
        rowKey: 'name',
        rows: keys,
        columns: [
          { key: 'name', label: 'Name', sortable: true },
          { key: 'createdAt', label: 'Added at', render: (row) => formatDateTime(row.createdAt) },
          {
            key: 'expiresAt',
            label: 'Stops at',
            sortable: true,
            render: (row) =>
              flex(
                { gap: 2, verticalAlign: 'center' },
                formatDateTime(row.expiresAt),
                tag({ color: 'amber' }, timeLeft(row.expiresAt)),
              ),
          },
          {
            key: 'actions',
            label: 'Actions',
            align: 'end',
            render: (row) =>
              button(
                {
                  variant: 'danger',
                  size: 'sm',
                  events: { click: () => onRemove(name, row.name) },
                },
                'Remove',
              ),
          },
        ],
      }),
      flex(add),
    )
  },
  error: (self, error) =>
    notice({ kind: 'error', title: 'The server did not send its agent keys' }, messageOf(error)),
})

const addForm = component('aly-agent-key-form', {
  setup: (self, { server, onAdded }) => {
    const api = useHttpClient(self, 'aly.api')
    return form(
      {
        initialValues: { name: '', hours: '1' },
        onSubmit: async (values) => {
          let added
          try {
            added = await addAgentKey(api, server, agentKeyBody(values))
          } catch (error) {
            throw new FormError(messageOf(error), { cause: error })
          }
          onAdded(added)
        },
      },
      notice(
        { kind: 'info', title: 'For AI agents that use the imp-aly CLI' },
        'The agent saves this key with the imp-aly CLI and calls the server with it. The key stops by itself after the time that you choose.',
      ),
      textField({
        field: 'name',
        label: 'Name',
        required: true,
        placeholder: 'claude',
        help: 'A name for the agent or the task. The agent also saves the server under this name.',
        validate: (value) =>
          isAppName(value ?? '')
            ? null
            : 'Use 1 to 63 lowercase letters, digits and "-". Start with a letter or a digit.',
      }),
      segmented({
        field: 'hours',
        label: 'The key works for',
        required: true,
        options: DURATIONS,
      }),
      flex(button({ variant: 'primary', events: { click: submitForm } }, 'Add the agent key')),
    )
  },
})

const createdView = ({ server, name, url, key, expiresAt }, onClose) =>
  stack(
    { gap: 4 },
    notice(
      { kind: 'warning', title: 'Copy the command now' },
      'The console does not keep the agent key, and the server does not show it again. When this window closes, the key is only in the command that you copied.',
    ),
    descriptionList({
      items: [
        { term: 'Server', details: server },
        { term: 'Name', details: name },
        { term: 'Stops at', details: formatDateTime(expiresAt) },
      ],
    }),
    text(
      'Give this command to the AI agent. It saves the server with the agent key for the imp-aly CLI. Then the agent uses -s '
        + name
        + ', for example imp-aly app ls -s '
        + name
        + '.',
    ),
    codeBlock({
      language: 'text',
      label: 'The command for the agent',
      code: agentCommand({ name, url, key }),
    }),
    flex(
      { horizontalAlign: 'end' },
      button({ variant: 'primary', events: { click: onClose } }, 'Done'),
    ),
  )

export const agentKeysScreen = component('aly-agent-keys', {
  setup: (self) => {
    const api = useHttpClient(self, 'aly.api')
    const catalog = useState(self, 'aly.catalog')
    const keysRevision = initState(self, 'aly.agentKeys.revision', 0)
    const adding = initState(self, 'aly.agentKeys.adding', null)
    const addOpen = initState(self, 'aly.agentKeys.addOpen', false)
    const createdId = initState(self, 'aly.agentKeys.created', 0)
    const createdOpen = initState(self, 'aly.agentKeys.createdOpen', false)
    const created = new Map()
    const saved = computed([catalog], (value) => value?.servers?.servers ?? null)
    const reload = () => keysRevision.set((value) => value + 1)
    const forget = () => {
      created.clear()
      createdId.set(0)
    }
    createdOpen.watch(self, (open) => {
      if (!open) forget()
    })
    self.abortSignal.addEventListener('abort', forget)

    const openAdd = (server) => {
      adding.set(server)
      addOpen.set(true)
    }

    const onAdded = (added) => {
      const id = createdId.get() + 1
      created.clear()
      created.set(id, { ...added, server: adding.get() })
      addOpen.set(false)
      createdId.set(id)
      createdOpen.set(true)
      reload()
    }

    const onRemove = async (server, name) => {
      try {
        await removeAgentKey(api, server, name)
        notify({
          kind: 'success',
          title: `Removed the agent key ${name}`,
          description: `${server} refuses the key now.`,
        })
      } catch (error) {
        notify({ kind: 'error', title: `${name} was not removed`, description: messageOf(error) })
      }
      reload()
    }

    const createdDialog = dialog(
      { title: 'The new agent key', open: createdOpen },
      createdId.view((id) =>
        created.has(id) ? createdView(created.get(id), () => createdOpen.set(false)) : null,
      ),
    )
    createdDialog.style.setProperty('--imp-dialog-inline-size', '48rem')

    const cards = computed([saved, keysRevision], (servers, revision) => ({ servers, revision }))

    return page(
      stack(
        { gap: 5 },
        screenHeader({
          title: 'Agent keys',
          description:
            'Temporary keys for AI agents that use the imp-aly CLI. Give an agent a key that stops by itself, and keep the key of the server to yourself.',
        }),
        notice({ kind: 'info', title: 'For AI agents that use the imp-aly CLI' }, ABOUT),
        cards.view(({ servers }) => {
          if (!servers) return text({ tone: 'secondary' }, 'Loading the servers...')
          if (!servers.length) {
            return emptyState({
              icon: luBot,
              title: 'No server is added',
              description: 'Add a server in Servers first. Then add agent keys for it here.',
            })
          }
          return stack(
            { gap: 5 },
            ...servers.map(({ name }) =>
              reportCard({ title: name }, serverKeys({ name, onAdd: openAdd, onRemove })),
            ),
          )
        }),
        dialog(
          {
            title: computed([adding], (server) => `Add an agent key to ${server ?? 'the server'}`),
            open: addOpen,
          },
          computed([adding, addOpen], (server, open) => (open ? server : null)).view((server) =>
            server ? addForm({ server, onAdded }) : null,
          ),
        ),
        createdDialog,
      ),
    )
  },
})
