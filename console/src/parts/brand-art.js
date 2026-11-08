import { component } from 'imp'
import { div } from 'imp/html'

const MAGENTA = '#d700d1'
const ORANGE = '#ee4b00'
const BLUE = '#0078ea'
const CELL = '32px'

const SQUARES = [
  { tone: 'ink', column: 0, row: 0, span: 2 },
  { tone: 'blue', column: 2, row: 0 },
  { tone: 'orange', column: 2, row: 1 },
  { tone: 'magenta', column: 2, row: 2 },
  { tone: 'outline', column: 0, row: 3 },
  { tone: 'faint', column: 4, row: 1 },
]

export const cornerArt = component('aly-corner-art', {
  styles: `
    :host {
      display: block;
      position: relative;
      overflow: hidden;
      pointer-events: none;
    }
    .geometry {
      position: absolute;
      inset-inline-end: 0;
      inset-block-end: 0;
      inline-size: min(36dvi, 400px);
      block-size: min(38dvb, 320px);
    }
    .grid {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(var(--imp-color-text, #101010) 1px, transparent 1px),
        linear-gradient(90deg, var(--imp-color-text, #101010) 1px, transparent 1px);
      background-size: ${CELL} ${CELL};
      background-position: right bottom;
      mask-image: radial-gradient(
        110% 110% at 100% 100%,
        black 0%,
        rgb(0 0 0 / 55%) 30%,
        transparent 62%
      );
      opacity: 0.16;
    }
    .square {
      box-sizing: border-box;
      position: absolute;
      inset-inline-end: calc(var(--column) * ${CELL});
      inset-block-end: calc(var(--row) * ${CELL});
      inline-size: calc(var(--span, 1) * ${CELL});
      block-size: calc(var(--span, 1) * ${CELL});
    }
    .ink { background: var(--imp-color-text, #101010); }
    .blue { background: ${BLUE}; }
    .orange { background: ${ORANGE}; }
    .magenta { background: ${MAGENTA}; }
    .outline { border: 1.5px solid var(--imp-color-text, #101010); }
    .faint {
      background: var(--imp-color-text, #101010);
      opacity: 0.3;
    }
    :host-context([dir='rtl']) .grid { background-position: left bottom; }
    @media (width < 48rem) {
      .geometry { display: none; }
    }
    @media (forced-colors: active) {
      .geometry { display: none; }
    }
  `,
  setup: () =>
    div(
      { class: 'geometry', 'aria-hidden': 'true' },
      div({ class: 'grid' }),
      ...SQUARES.map(({ tone, column, row, span = 1 }) =>
        div({
          class: ['square', tone],
          style: { '--column': column, '--row': row, '--span': span },
        }),
      ),
    ),
})

export const colorBars = component('aly-color-bars', {
  styles: `
    :host {
      display: block;
      position: relative;
      pointer-events: none;
    }
    .bars {
      position: absolute;
      inset-block: 0;
      inset-inline-end: 0;
      display: flex;
      gap: 6px;
      padding-inline-end: 6px;
    }
    .bars div { inline-size: 10px; }
    .bars .magenta { inline-size: 14px; background: ${MAGENTA}; }
    .bars .orange { background: ${ORANGE}; }
    .bars .blue { background: ${BLUE}; }
    @media (forced-colors: active) {
      .bars { display: none; }
    }
  `,
  setup: () =>
    div(
      { class: 'bars', 'aria-hidden': 'true' },
      div({ class: 'magenta' }),
      div({ class: 'orange' }),
      div({ class: 'blue' }),
    ),
})

export const barsRoom = component('aly-bars-room', {
  styles: `
    :host {
      display: block;
      flex: none;
      inline-size: 52px;
    }
    @media (width < 48rem) {
      :host { display: none; }
    }
  `,
  setup: () => null,
})
