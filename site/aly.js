const config = document.querySelector('script[data-aly-app]')?.dataset ?? {}
const { alyServer: server, alyApp: app, alyPage: page } = config

const BATCH_SIZE = 20
const BATCH_MS = 5000
const USE_EVENTS = ['click', 'input', 'keydown']
const NOT_USE_KEY = /^(?:Tab|Shift|Control|Alt|Meta|CapsLock|Escape|F[1-9]|F1[0-9]|F2[0-4])$/
const VISIT_ID = /^[A-Za-z0-9_-]{1,64}$/

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

const visitOf = () => {
  const key = `${app}.visit`
  try {
    const stored = sessionStorage.getItem(key)
    if (stored && VISIT_ID.test(stored)) return stored
    const id = randomId()
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return randomId()
  }
}

const start = () => {
  const url = `${server.replace(/\/+$/, '')}/collect/${app}`
  const visit = visitOf()
  let held = []
  let timer = null
  let sentFirst = false

  const flush = () => {
    clearTimeout(timer)
    timer = null
    if (!held.length) return
    const body = JSON.stringify(held)
    held = []
    fetch(url, {
      method: 'POST',
      body,
      keepalive: true,
      credentials: 'omit',
      referrerPolicy: 'strict-origin',
    }).catch(() => {})
  }

  const send = (type, fields) => {
    held.push({ type, visit, at: Date.now(), page, ...fields })
    if (!sentFirst || held.length >= BATCH_SIZE) {
      sentFirst = true
      flush()
      return
    }
    timer ??= setTimeout(flush, BATCH_MS)
  }

  const seen = new Set()
  const used = new Set()
  const intersecting = new Set()

  const sendSeen = (zone) => {
    if (seen.has(zone)) return
    seen.add(zone)
    send('seen', { zone })
  }

  const sendUsed = (zone) => {
    if (used.has(zone)) return
    used.add(zone)
    if (zone !== null) sendSeen(zone)
    send('used', { zone })
  }

  const markSeen = () => {
    if (document.visibilityState !== 'visible') return
    for (const element of intersecting) sendSeen(element.dataset.zone)
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) intersecting.add(entry.target)
      else intersecting.delete(entry.target)
    }
    markSeen()
  })

  const onUse = (event) => {
    if (!event.isTrusted) return
    if (event.type === 'keydown' && NOT_USE_KEY.test(event.key)) return
    sendUsed(null)
    for (const node of event.composedPath()) {
      const zone = node.dataset?.zone
      if (zone) sendUsed(zone)
    }
    const outcome = event.type === 'click' && event.target.closest?.('[data-outcome]')
    if (outcome) send('outcome', { name: outcome.dataset.outcome })
  }

  send('page')
  for (const zone of document.querySelectorAll('[data-zone]')) observer.observe(zone)
  for (const type of USE_EVENTS) {
    document.addEventListener(type, onUse, { capture: true, passive: true })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') markSeen()
    else flush()
  })
  addEventListener('pagehide', flush)
}

if (server && app && page && navigator.webdriver !== true) {
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', start, { once: true })
  } else {
    start()
  }
}
