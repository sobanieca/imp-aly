import { component } from 'imp'
import { div } from 'imp/html'
import { computed, useState } from 'imp/state'
import { button, icon, text } from 'imp/std'
import { comboBox, datePicker, segmented, select } from 'imp/std/inputs'
import { luRefreshCw } from 'imp/icons'
import { PRESETS, todayUtc } from '../lib/days.js'

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
  const names = [...new Set((catalog?.apps ?? []).map(({ name }) => name))].sort()
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
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: var(--imp-space-3, 12px);
    }
    .grow { flex: 0 1 15rem; min-inline-size: 11rem; }
  `,
  setup: (self, { reports = true } = {}) => {
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
      { class: 'bar' },
      div({ class: 'grow' }, saved.view((store) => serverControl(store, servers))),
      reports ? div({ class: 'grow' }, catalog.view((value) => appControl(value, app))) : null,
      reports ? segmented({ label: 'Period', value: preset, options: PRESETS }) : null,
      reports
        ? datePicker({
          label: 'Days (UTC)',
          value: range,
          range: true,
          required: true,
          max: todayUtc(),
        })
        : null,
      button(
        {
          square: true,
          label: reports ? 'Run the report again' : 'Load again',
          events: { click: again },
        },
        icon(luRefreshCw),
      ),
    )
  },
})
