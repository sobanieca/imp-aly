import { component } from 'imp'
import { div } from 'imp/html'
import { computed, useState } from 'imp/state'
import { button, icon } from 'imp/std'
import { comboBox, dateRangePicker } from 'imp/std/inputs'
import { luRefreshCw } from 'imp/icons'
import { presetRange, PRESETS, todayUtc } from '../lib/days.js'

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

const presetChoices = () =>
  PRESETS.map(({ value, label }) => ({ value, label, range: presetRange(value) }))

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
  setup: (self, { period = true } = {}) => {
    const catalog = useState(self, 'aly.catalog')
    const servers = useState(self, 'aly.scope.servers')
    const chosen = useState(self, 'aly.scope.period')
    const tick = useState(self, 'aly.scope.tick')
    const revision = useState(self, 'aly.revision')
    const saved = computed([catalog], (value) => value?.servers ?? null)
    const again = () => {
      tick.set((value) => value + 1)
      revision.set((value) => value + 1)
    }
    return div(
      { class: 'bar' },
      period
        ? dateRangePicker({
          label: 'Period (UTC)',
          value: chosen,
          presets: presetChoices(),
          max: todayUtc(),
        })
        : null,
      saved.view((store) => serverControl(store, servers)),
      button(
        {
          square: true,
          label: period ? 'Run the report again' : 'Load again',
          events: { click: again },
        },
        icon(luRefreshCw),
      ),
    )
  },
})
