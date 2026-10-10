let deferred = null
let installed = false
const listeners = new Set()

const announce = () => {
  for (const listener of listeners) listener()
}

const APP_DISPLAY_MODES = ['standalone', 'minimal-ui', 'window-controls-overlay']

const displayQueries = (scope) =>
  typeof scope.matchMedia === 'function'
    ? APP_DISPLAY_MODES.map((mode) => scope.matchMedia(`(display-mode: ${mode})`))
    : []

export const runsAsApp = (scope = globalThis) =>
  scope.navigator?.standalone === true || displayQueries(scope).some((query) => query.matches)

export const isIos = (nav = globalThis.navigator) => {
  if (!nav) return false
  return /iPad|iPhone|iPod/.test(nav.userAgent ?? '') ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
}

export const installModeOf = ({ installed, prompt, app, secure, ios }) => {
  if (installed || app || !secure) return 'none'
  if (prompt) return 'prompt'
  return ios ? 'manual' : 'none'
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferred = event
    announce()
  })
  globalThis.addEventListener('appinstalled', () => {
    deferred = null
    installed = true
    announce()
  })
  for (const query of displayQueries(globalThis)) query.addEventListener?.('change', announce)
}

export const installMode = () =>
  installModeOf({
    installed,
    prompt: deferred !== null,
    app: runsAsApp(),
    secure: globalThis.isSecureContext !== false,
    ios: isIos(),
  })

export const onInstallChange = (listener, signal) => {
  listeners.add(listener)
  signal.addEventListener('abort', () => listeners.delete(listener))
}

export const promptInstall = async () => {
  const event = deferred
  if (!event) return 'unavailable'
  deferred = null
  announce()
  await event.prompt()
  const { outcome } = await event.userChoice
  return outcome
}
