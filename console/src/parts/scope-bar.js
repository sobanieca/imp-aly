import { component } from 'imp'
import { div } from 'imp/html'
import { computed, useState } from 'imp/state'
import { button, icon, text } from 'imp/std'
import { comboBox, datePicker, segmented, select } from 'imp/std/inputs'
import { luRefreshCw } from 'imp/icons'
import { appNamesOf } from '../lib/catalog.js'
import { barNote, barOf, dayCount, PRESETS, previousRange, todayUtc } from '../lib/days.js'
import { formatCount } from '../lib/format.js'

const rangeNote = (value) => {
  if (!value?.start || !value?.end) return ''
  const before = previousRange(value.start, value.end)
  return `${barNote(barOf(value.start, value.end))} A change compares with the ${
    formatCount(dayCount(value.start, value.end))
  } days before, ${before.from} to ${before.to}.`
}

const serverControl = (store, servers) => {
  const saved = store?.servers ?? []
  if (!saved.length) {
    return text(
      { size: 'sm', tone: 'secondary' },
      `Server: ${store?.localUrl ?? 'the local server'}`,
    )
  }
  return comboBox({
    label: 'Servers',
    value: servers,
    multiple: true,
    options: saved.map(({ name }) => name),
    placeholder: `Default: ${store.default}`,
  })
}

const appControl = (catalog, app) => {
  const names = appNamesOf(catalog)
  return select({
    label: 'App',
    value: app,
    options: names,
    placeholder: catalog === undefined ? 'Loading...' : names.length ? 'Choose an app' : 'No app',
    disabled: !names.length,
  })
}

export const scopeBar = component('aly-scope-bar', {
  styles: `
    :host { display: block; }
    .scope { display: grid; gap: var(--imp-space-2, 8px); }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: var(--imp-space-3, 12px);
    }
    .grow { flex: 0 1 15rem; min-inline-size: 11rem; }
  `,
  setup: (self, { app: withApp = true, period = true, note = false } = {}) => {
    const catalog = useState(self, 'aly.catalog')
    const servers = useState(self, 'aly.scope.servers')
    const app = useState(self, 'aly.scope.app')
    const range = useState(self, 'aly.scope.range')
    const preset = useState(self, 'aly.scope.preset')
    const tick = useState(self, 'aly.scope.tick')
    const revision = useState(self, 'aly.revision')
    const saved = computed([catalog], (value) => value?.servers ?? null)
    const again = () => {
      tick.set((value) => value + 1)
      revision.set((value) => value + 1)
    }
    return div(
      { class: 'scope' },
      div(
        { class: 'bar' },
        div({ class: 'grow' }, saved.view((store) => serverControl(store, servers))),
        withApp ? div({ class: 'grow' }, catalog.view((value) => appControl(value, app))) : null,
        period ? segmented({ label: 'Period', value: preset, options: PRESETS }) : null,
        period
          ? datePicker({
            label: 'From - to (UTC)',
            value: range,
            range: true,
            required: true,
            max: todayUtc(),
          })
          : null,
        button(
          {
            square: true,
            label: period ? 'Run the report again' : 'Load again',
            events: { click: again },
          },
          icon(luRefreshCw),
        ),
      ),
      note ? text({ size: 'sm', tone: 'secondary' }, range.text(rangeNote)) : null,
    )
  },
})
