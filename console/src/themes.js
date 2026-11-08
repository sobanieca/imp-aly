const TYPE = {
  'font-family': "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  'font-family-heading': "'Space Grotesk', 'IBM Plex Sans', system-ui, sans-serif",
  'font-family-mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  'font-size-sm': '0.8125rem',
  'font-size-md': '0.875rem',
  'font-size-lg': '1rem',
  'font-size-xl': '1.375rem',
  'font-size-2xl': '1.875rem',
  'font-weight-normal': '400',
  'font-weight-bold': '600',
  'line-height-tight': '1.2',
  'line-height-normal': '1.57',
}

const SHAPE = {
  'radius-item': '4px',
  'radius-container': '8px',
  'icon-stroke-width': '1.5',
  'shadow-sm': 'none',
  'shadow-md': '0 6px 20px rgb(from var(--imp-color-shadow) r g b / 14%)',
  'shadow-lg': '0 12px 32px rgb(from var(--imp-color-shadow) r g b / 22%)',
  loader: 'bar',
}

const BRIGHT_PALETTE = {
  'color-gray': '#8b8b96',
  'color-red': '#ff6b6b',
  'color-orange': '#ff8a3d',
  'color-amber': '#f5b83d',
  'color-yellow': '#facc15',
  'color-lime': '#a3e635',
  'color-green': '#4cc47a',
  'color-teal': '#2dd4bf',
  'color-cyan': '#22d3ee',
  'color-sky': '#7dd3fc',
  'color-blue': '#5aa9ff',
  'color-indigo': '#818cf8',
  'color-violet': '#a78bfa',
  'color-purple': '#d07cf5',
  'color-pink': '#f472d0',
}

const grid = (line, base) =>
  [
    `linear-gradient(${line} 1px, transparent 1px) 100% 100% / 32px 32px`,
    `linear-gradient(90deg, ${line} 1px, transparent 1px) 100% 100% / 32px 32px`,
    base,
  ].join(', ')

const alyLight = {
  name: 'aly-light',
  label: 'Light',
  base: 'imp-light',
  tokens: {
    ...TYPE,
    ...SHAPE,
    'color-scheme': 'light',
    'color-primary': '#101010',
    'color-on-primary': '#ffffff',
    'color-secondary': '#5b5b63',
    'color-text': '#101010',
    'color-heading': '#101010',
    'color-surface': '#ffffff',
    'color-surface-sunken': '#f1f1f4',
    'color-surface-hover': '#e3e3e8',
    'color-border': '#e3e3e8',
    'color-shadow': '#101010',
    'color-info': '#0063c4',
    'color-success': '#137a3a',
    'color-warning': '#8a5a00',
    'color-danger': '#c62828',
    'color-on-danger': '#ffffff',
    'background-app': grid('rgb(16 16 16 / 4%)', '#fafafa'),
  },
}

const alyDim = {
  name: 'aly-dim',
  label: 'Dim',
  base: 'imp-dark',
  tokens: {
    ...TYPE,
    ...SHAPE,
    ...BRIGHT_PALETTE,
    'color-scheme': 'dark',
    'color-primary': '#ececf1',
    'color-on-primary': '#1e1f24',
    'color-secondary': '#a9aab5',
    'color-text': '#ececf1',
    'color-heading': '#ececf1',
    'color-surface': '#26272d',
    'color-surface-sunken': '#2d2e35',
    'color-surface-hover': '#383943',
    'color-border': '#3a3b45',
    'color-shadow': '#000000',
    'color-info': '#6db3ff',
    'color-success': '#5fd08b',
    'color-warning': '#e8b04a',
    'color-danger': '#ff7b7b',
    'color-on-danger': '#1e1f24',
    'background-app': grid('rgb(236 236 241 / 4%)', '#1e1f24'),
  },
}

const alyDark = {
  name: 'aly-dark',
  label: 'Dark',
  base: 'imp-dark',
  tokens: {
    ...TYPE,
    ...SHAPE,
    ...BRIGHT_PALETTE,
    'color-scheme': 'dark',
    'color-primary': '#fafafa',
    'color-on-primary': '#101010',
    'color-secondary': '#a3a3ad',
    'color-text': '#fafafa',
    'color-heading': '#fafafa',
    'color-surface': '#18181b',
    'color-surface-sunken': '#222226',
    'color-surface-hover': '#2e2e33',
    'color-border': '#2e2e33',
    'color-shadow': '#000000',
    'color-info': '#5aa9ff',
    'color-success': '#4cc47a',
    'color-warning': '#e0a53a',
    'color-danger': '#ff6b6b',
    'color-on-danger': '#101010',
    'background-app': grid('rgb(250 250 250 / 4%)', '#101010'),
  },
}

export const THEMES = ['system', alyLight, alyDark, alyDim]
