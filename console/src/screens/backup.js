import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { computed, initState, useState } from 'imp/state'
import { button, text } from 'imp/std'
import { table } from 'imp/std/data'
import { notice, notify } from 'imp/std/feedback'
import { dateRangePicker, fileUpload, form, FormError, select, submitForm } from 'imp/std/inputs'
import { flex, stack } from 'imp/std/layout'
import { downloadBlob, messageOf } from '../lib/api.js'
import { downloadBackup, restoreBackup } from '../lib/client.js'
import { todayUtc } from '../lib/days.js'
import { columns, noApp, page, reportCard, screenHeader } from '../parts/report.js'

const serverOptions = (catalog) => {
  const saved = catalog?.servers?.servers ?? []
  return saved.map(({ name }) => name)
}

const serverField = (catalog) =>
  select({ field: 'server', label: 'Server', options: serverOptions(catalog), required: true })

const backupForm = component('aly-backup-form', {
  setup: (self, catalog) => {
    const api = useHttpClient(self, 'aly.api')
    const apps = [...new Set((catalog?.apps ?? []).map(({ name }) => name))].sort()
    return form(
      {
        initialValues: {
          server: catalog?.servers?.default || undefined,
          app: undefined,
          days: undefined,
        },
        onSubmit: async (values) => {
          let backup
          try {
            backup = await downloadBackup(api, values.server, {
              app: values.app,
              from: values.days?.start,
              to: values.days?.end,
            })
          } catch (error) {
            throw new FormError(messageOf(error), { cause: error })
          }
          downloadBlob(backup.fileName, backup.blob)
          notify({ kind: 'success', title: `Downloaded ${backup.fileName}` })
        },
      },
      serverField(catalog),
      select({ field: 'app', label: 'App', options: apps, placeholder: 'All apps' }),
      dateRangePicker({
        field: 'days',
        label: 'Days (UTC)',
        max: todayUtc(),
        help: 'Empty: all the sealed days.',
      }),
      flex(button({ variant: 'primary', events: { click: submitForm } }, 'Download the backup')),
    )
  },
})

const restoreForm = component('aly-restore-form', {
  setup: (self, catalog) => {
    const api = useHttpClient(self, 'aly.api')
    const result = useState(self, 'aly.backup.result')
    let files = []
    return form(
      {
        initialValues: { server: catalog?.servers?.default || undefined, files: [] },
        onSubmit: async (values) => {
          try {
            const answer = await restoreBackup(api, values.server, files[0])
            result.set(answer)
            notify({
              kind: 'success',
              title: `Restored ${answer.restored.length} days`,
              description: `Skipped ${answer.skipped.length} days.`,
            })
          } catch (error) {
            throw new FormError(messageOf(error), { cause: error })
          }
        },
      },
      serverField(catalog),
      fileUpload({
        field: 'files',
        label: 'Backup file',
        accept: '.gz,.tgz,application/gzip',
        required: true,
        onFiles: (chosen) => {
          files = chosen
        },
      }),
      flex(button({ variant: 'primary', events: { click: submitForm } }, 'Restore')),
    )
  },
})

const restoreResult = (value) =>
  value
    ? stack(
      { gap: 3 },
      text(
        `${value.server}: restored ${value.restored.length} days, skipped ${value.skipped.length} days.`,
      ),
      value.skipped.length
        ? table({
          label: 'Skipped days',
          rowKey: 'key',
          rows: value.skipped.map((entry) => ({ key: `${entry.app} ${entry.day}`, ...entry })),
          columns: [
            { key: 'app', label: 'App' },
            { key: 'day', label: 'Day' },
            { key: 'reason', label: 'Reason' },
          ],
        })
        : null,
    )
    : null

export const backupScreen = component('aly-backup', {
  setup: (self) => {
    const catalog = useState(self, 'aly.catalog')
    const result = initState(self, 'aly.backup.result', null)
    const ready = computed([catalog], (value) => {
      if (value === undefined) return 'loading'
      return value.servers?.servers.length ? 'ready' : 'empty'
    })
    return page(
      stack(
        { gap: 5 },
        screenHeader({
          title: 'Backup',
          description:
            'A backup holds the daily summaries of the sealed days. A restore puts them into a server.',
        }),
        ready.view((state) => {
          if (state === 'loading') return text({ tone: 'secondary' }, 'Loading...')
          if (state === 'empty') return noApp(catalog)
          return columns(
            reportCard(
              {
                title: 'Download a backup',
                description:
                  'The server seals a day at 01:10 UTC of the next day. The current day is not in the backup.',
              },
              backupForm(catalog.get()),
            ),
            reportCard(
              {
                title: 'Restore a backup',
                description:
                  'The server adds the days that it does not hold. It does not replace a day that it holds.',
              },
              restoreForm(catalog.get()),
              result.view(restoreResult),
            ),
          )
        }),
        notice(
          { kind: 'info', title: 'A backup does not hold the app registry and the key' },
          'Copy apps.json from the data folder and the key file yourself.',
        ),
      ),
    )
  },
})
