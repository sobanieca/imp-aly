import { component } from 'imp'
import { div } from 'imp/html'
import { computed, useState } from 'imp/state'
import { button, icon } from 'imp/std'
import { comboBox, datePicker, segmented, select } from 'imp/std/inputs'
import { luRefreshCw } from 'imp/icons'
import { appNamesOf } from '../lib/catalog.js'
import { PRESETS, todayUtc } from '../lib/days.js'

const serverControl = (store, servers) => {
  const saved = store?.servers ?? []
  if (saved.length < 2) return null
  return div(
    { class: 'grow' },
    comboBox({
      label: 'Servers',
      value: servers,
      multiple: true,
      options: saved.map(({ name }) => name),
      placeholder: `Active: ${store.default}`,
    }),
  )
}

const appControl = (catalog, app) => {
  const names = appNamesOf(catalog)
  if (names.length < 2) return null
  return div({ class: 'grow' }, select({ label: 'App', value: app, options: names }))
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
  setup: (self, { app: withApp = true, period = true } = {}) => {
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
        saved.view((store) => serverControl(store, servers)),
        withApp ? catalog.view((value) => appControl(value, app)) : null,
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
    )
  },
})
