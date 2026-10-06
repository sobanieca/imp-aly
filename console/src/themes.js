const FONTS = {
  'font-family': "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  'font-family-heading': "'Space Grotesk', 'IBM Plex Sans', system-ui, sans-serif",
  'font-family-mono': "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  'font-size-2xl': '1.875rem',
  'line-height-tight': '1.2',
  'line-height-normal': '1.55',
}

const METRICS = {
  ...FONTS,
  'radius-item': '4px',
  'radius-container': '8px',
  'icon-stroke-width': '1.75',
  loader: 'bar',
}

const grid = (line) =>
  [
    `linear-gradient(${line} 1px, transparent 1px) 0 0 / 32px 32px`,
    `linear-gradient(90deg, ${line} 1px, transparent 1px) 0 0 / 32px 32px`,
  ].join(', ')

export const alyDark = {
  name: 'aly-dark',
  base: 'imp-dark',
  tokens: {
    ...METRICS,
    'color-scheme': 'dark',
    'color-primary': '#2dd4bf',
    'color-on-primary': '#042f2a',
    'color-secondary': '#8e9bb0',
    'color-danger': '#f87171',
    'color-on-danger': '#2a0707',
    'color-text': '#d5deea',
    'color-heading': '#f3f7fc',
    'color-surface': '#111823',
    'color-surface-sunken': '#0b1018',
    'color-surface-hover': '#1a2433',
    'color-border': '#243246',
    'color-shadow': '#000000',
    'shadow-sm': '0 1px 2px rgb(0 0 0 / 40%), inset 0 1px 0 rgb(255 255 255 / 3%)',
    'shadow-md': '0 8px 24px rgb(0 0 0 / 45%)',
    'shadow-lg': '0 20px 48px rgb(0 0 0 / 55%)',
    'background-app': [
      'radial-gradient(80rem 40rem at 100% -10%, rgb(45 212 191 / 9%), transparent 60%)',
      'radial-gradient(60rem 40rem at -10% 110%, rgb(79 157 255 / 7%), transparent 60%)',
      grid('rgb(148 163 184 / 4%)'),
      '#0b1018',
    ].join(', '),
    'color-gray': '#64748b',
    'color-red': '#f87171',
    'color-orange': '#fb923c',
    'color-amber': '#fbbf24',
    'color-yellow': '#facc15',
    'color-lime': '#a3e635',
    'color-green': '#34d399',
    'color-teal': '#2dd4bf',
    'color-cyan': '#22d3ee',
    'color-sky': '#7dd3fc',
    'color-blue': '#4f9dff',
    'color-indigo': '#818cf8',
    'color-violet': '#a78bfa',
    'color-purple': '#c084fc',
    'color-pink': '#f472b6',
  },
}

export const alyLight = {
  name: 'aly-light',
  base: 'imp-light',
  tokens: {
    ...METRICS,
    'color-scheme': 'light',
    'color-primary': '#0f766e',
    'color-on-primary': '#ffffff',
    'color-secondary': '#55627a',
    'color-text': '#1c2534',
    'color-heading': '#0a1220',
    'color-surface': '#ffffff',
    'color-surface-sunken': '#f1f4f8',
    'color-surface-hover': '#e8edf3',
    'color-border': '#d3dbe6',
    'color-shadow': '#0f172a',
    'background-app': [
      'radial-gradient(80rem 40rem at 100% -10%, rgb(15 118 110 / 7%), transparent 60%)',
      grid('rgb(15 23 42 / 4%)'),
      '#f1f4f8',
    ].join(', '),
    'color-blue': '#2563eb',
    'color-teal': '#0d9488',
    'color-cyan': '#0891b2',
  },
}
