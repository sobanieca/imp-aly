import { component } from 'imp'
import { div } from 'imp/html'
import { navigate } from 'imp/router'
import { useState } from 'imp/state'
import { button, heading, text } from 'imp/std'
import { card, emptyState } from 'imp/std/display'
import { loader, notice, skeleton } from 'imp/std/feedback'
import { stack } from 'imp/std/layout'
import { luBox, luCalendarX } from 'imp/icons'
import { app } from '../app-map.js'
import { messageOf } from '../lib/api.js'
import { formatCount } from '../lib/format.js'
import { useScope } from '../lib/scope.js'
import { scopeBar } from './scope-bar.js'

const TILE_STYLES = `
  :host { display: block; block-size: 100%; }
  .tile {
    box-sizing: border-box;
    block-size: 100%;
    padding: var(--imp-space-4, 16px);
    background-color: var(--imp-color-surface, #ffffff);
    border: var(--imp-border-width, 1px) solid var(--imp-color-border, #cbd5e1);
    border-radius: var(--imp-radius-container, 10px);
    box-shadow: var(--imp-shadow-sm, 0 1px 2px rgb(15 23 42 / 10%));
    color: var(--imp-color-text, #0f172a);
    font-family: var(--imp-font-family, system-ui, sans-serif);
  }
  .label, .hint {
    color: var(--imp-color-secondary, #475569);
    font-size: var(--imp-font-size-sm, 0.875rem);
  }
  .value {
    margin-block: var(--imp-space-1, 4px);
    font-size: var(--imp-font-size-2xl, 1.5rem);
    font-weight: var(--imp-font-weight-bold, 600);
    line-height: var(--imp-line-height-tight, 1.2);
    font-variant-numeric: tabular-nums;
  }
  @media (forced-colors: active) {
    .tile { border-color: CanvasText; }
  }
`

export const statTile = component('aly-stat-tile', {
  styles: TILE_STYLES,
  setup: (self, { label, value, hint }) =>
    div(
      { class: 'tile' },
      div({ class: 'label' }, label),
      div({ class: 'value' }, value),
      hint ? div({ class: 'hint' }, hint) : null,
    ),
})

export const tileGrid = component('aly-tile-grid', {
  styles: `
    :host { display: block; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
      gap: var(--imp-space-3, 12px);
    }
  `,
  setup: (self, ...tiles) => div({ class: 'grid' }, ...tiles),
})

export const columns = component('aly-columns', {
  styles: `
    :host { display: block; }
    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr));
      gap: var(--imp-space-4, 16px);
      align-items: start;
    }
  `,
  setup: (self, ...items) => div({ class: 'columns' }, ...items),
})

export const page = component('aly-page', {
  styles: `
    :host { display: block; }
    .page {
      box-sizing: border-box;
      max-inline-size: 90rem;
      padding: var(--imp-space-page, 24px);
    }
  `,
  setup: (self, content) => div({ class: 'page' }, content),
})

export const wide = (panel) => {
  panel.style.setProperty('--imp-drawer-inline-size', '46rem')
  return panel
}

export const reportCard = ({ title, description, actions }, ...content) =>
  card(
    {
      header: actions
        ? stack({ gap: 2 }, heading({ level: 2 }, title), actions)
        : heading({ level: 2 }, title),
    },
    stack(
      { gap: 3 },
      description ? text({ tone: 'secondary', size: 'sm' }, description) : null,
      ...content,
    ),
  )

export const screenHeader = (title, description) =>
  stack({ gap: 1 }, heading({ level: 1 }, title), text({ tone: 'secondary' }, description))

export const reportLoading = () => stack({ gap: 4 }, skeleton({ lines: 2 }), skeleton({ lines: 6 }))

export const reportError = (error) =>
  notice({ kind: 'error', title: 'The report did not load' }, messageOf(error))

const plural = (count, word) => `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`

export const problemNotices = ({ failed, skipped, warnings }) =>
  [
    failed.length
      ? notice(
        { kind: 'warning', title: 'The numbers are not complete' },
        `${plural(failed.length, 'server')} did not answer. ${
          failed.map(({ server, reason }) => `${server}: ${reason}`).join(' ')
        }`,
      )
      : null,
    skipped.length
      ? notice(
        { kind: 'info', title: `${plural(skipped.length, 'day')} are not in the numbers` },
        skipped.slice(0, 5).map(({ server, day, reason }) =>
          `${day}${server ? ` (${server})` : ''}: ${reason}`
        ).join(' '),
      )
      : null,
    ...warnings.map((warning) => notice({ kind: 'warning', title: 'Check the app' }, warning)),
  ].filter(Boolean)

export const dataNote = (answer) =>
  text(
    { tone: 'secondary', size: 'sm' },
    `${plural(answer.days, 'day')} with data, ${plural(answer.scanned, 'record')} read, ${
      plural(answer.matched, 'record')
    } matched.`,
  )

export const noRecords = (answer) =>
  emptyState({
    icon: luCalendarX,
    title: 'No records in these days',
    description:
      `The servers hold no record of ${answer.app} from ${answer.from} to ${answer.to}. Choose other days.`,
  })

const noApp = (catalog) =>
  catalog.view((value) => {
    if (value === undefined) return loader({ label: 'Loading the apps' })
    if (value.error) {
      return notice({ kind: 'error', title: 'The apps did not load' }, value.error)
    }
    return emptyState(
      {
        icon: luBox,
        title: 'No app is registered',
        description: 'Register an app, then send records to the server.',
      },
      button(
        { variant: 'primary', events: { click: () => navigate(app.console.apps.href()) } },
        'Register an app',
      ),
    )
  })

export const reportScreen = (self, { title, description, render }) => {
  const scope = useScope(self)
  const catalog = useState(self, 'aly.catalog')
  return page(
    stack(
      { gap: 5 },
      screenHeader(title, description),
      scopeBar(),
      div(scope.view((value) => (value.app && value.from ? render(value) : noApp(catalog)))),
    ),
  )
}
