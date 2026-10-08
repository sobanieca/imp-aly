import { component } from 'imp'
import { useHttpClient } from 'imp/http'
import { computed, initState, useState } from 'imp/state'
import { button, text } from 'imp/std'
import { table } from 'imp/std/data'
import { notice, notify } from 'imp/std/feedback'
import { fileUpload, form, FormError, segmented, select, submitForm } from 'imp/std/inputs'
import { flex, stack } from 'imp/std/layout'
import { downloadBlob, messageOf } from '../lib/api.js'
import { downloadBackup, restoreBackup } from '../lib/client.js'
import { columns, noApp, page, reportCard, screenHeader } from '../parts/report.js'

const serverOptions = (catalog) => {
  const saved = catalog?.servers?.servers ?? []
  return saved.map(({ name }) => name)
}

const serverField = (catalog) =>
  select({ field: 'server', label: 'Server', options: serverOptions(catalog), required: true })

const PERIODS = [
  { value: '1d', label: 'The last day' },
  { value: '7d', label: 'The last 7 days' },
  { value: '30d', label: 'The last 30 days' },
  { value: '3m', label: 'The last 3 months' },
  { value: '6m', label: 'The last 6 months' },
  { value: '1y', label: 'The last year' },
  { value: 'all', label: 'All the days' },
]

const GRANULARITIES = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

const backupForm = component('aly-backup-form', {
  setup: (self, catalog) => {
    const api = useHttpClient(self, 'aly.api')
    return form(
      {
        initialValues: {
          server: catalog?.servers?.default || undefined,
          last: 'all',
          by: 'day',
        },
        onSubmit: async (values) => {
          let backup
          try {
            backup = await downloadBackup(api, values.server, { last: values.last, by: values.by })
          } catch (error) {
            throw new FormError(messageOf(error), { cause: error })
          }
          downloadBlob(backup.fileName, backup.blob)
          notify({ kind: 'success', title: `Downloaded ${backup.fileName}` })
        },
      },
      serverField(catalog),
      select({
        field: 'last',
        label: 'Period',
        options: PERIODS,
        required: true,
        help: 'The period ends at the last sealed day.',
      }),
      segmented({
        field: 'by',
        label: 'Granularity',
        options: GRANULARITIES,
        required: true,
        help: 'A week or a month is in the backup when it is complete and inside the period.',
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
              title: `Restored ${answer.restored.length} summaries`,
              description: `Skipped ${answer.skipped.length}.`,
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
        `${value.server}: restored ${value.restored.length} summaries, skipped ${value.skipped.length}.`,
      ),
      value.skipped.length
        ? table({
          label: 'Skipped summaries',
          rowKey: 'key',
          rows: value.skipped.map((entry) => {
            const period = entry.day ?? (entry.week ? `week ${entry.week}` : `month ${entry.month}`)
            return { key: `${entry.app} ${period} ${entry.source}`, period, ...entry }
          }),
          columns: [
            { key: 'app', label: 'App' },
            { key: 'period', label: 'Day or period' },
            { key: 'source', label: 'Source' },
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
            'A backup holds the summaries of the days, weeks or months of a server. A restore puts them into a server.',
        }),
        ready.view((state) => {
          if (state === 'loading') return text({ tone: 'secondary' }, 'Loading...')
          if (state === 'empty') return noApp(catalog)
          return columns(
            reportCard(
              {
                title: 'Download a backup',
                description:
                  'The backup holds all the apps and sources of the server. The server seals a day at 01:10 UTC of the next day.',
              },
              backupForm(catalog.get()),
            ),
            reportCard(
              {
                title: 'Restore a backup',
                description:
                  'The server adds the summaries that it does not hold. It does not replace a summary that it holds.',
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
