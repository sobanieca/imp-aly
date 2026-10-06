let deferred = null
let installed = false
const listeners = new Set()

const announce = () => {
  for (const listener of listeners) listener()
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
}

const isStandalone = () =>
  globalThis.matchMedia?.('(display-mode: standalone)').matches === true ||
  globalThis.navigator?.standalone === true

const isIos = () => {
  const nav = globalThis.navigator
  if (!nav) return false
  return /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
}

export const installMode = () => {
  if (installed || isStandalone()) return 'none'
  if (deferred) return 'prompt'
  return isIos() ? 'manual' : 'none'
}

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
