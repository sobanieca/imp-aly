import { component } from 'imp'
import { div } from 'imp/html'
import { useState } from 'imp/state'
import { button, icon } from 'imp/std'
import { dateRangePicker } from 'imp/std/inputs'
import { luRefreshCw } from 'imp/icons'
import { presetRange, PRESETS } from '../lib/ranges.js'
import { syncToday } from '../lib/scope.js'

const presetChoices = (today) =>
  PRESETS.map(({ value, label }) => ({ value, label, range: presetRange(value, today) }))

export const scopeBar = component('aly-scope-bar', {
  styles: `
    :host { display: block; }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: var(--imp-space-3, 12px);
    }
  `,
  setup: (self, { period = true } = {}) => {
    const chosen = useState(self, 'aly.scope.period')
    const tick = useState(self, 'aly.scope.tick')
    const revision = useState(self, 'aly.revision')
    const today = useState(self, 'aly.scope.today')
    const again = () => {
      syncToday(today)
      tick.set((value) => value + 1)
      revision.set((value) => value + 1)
    }
    return div(
      { class: 'bar' },
      period
        ? today.view((day) =>
            dateRangePicker({
              label: 'Period (UTC)',
              value: chosen,
              presets: presetChoices(day),
              max: day,
            }),
          )
        : null,
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
