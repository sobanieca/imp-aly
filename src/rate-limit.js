export const DEFAULT_LIMITS = [
  { name: '5s', ms: 5_000, limit: 200 },
  { name: '1m', ms: 60_000, limit: 1_500 },
  { name: '1h', ms: 3_600_000, limit: 30_000 },
  { name: '24h', ms: 86_400_000, limit: 200_000 },
]

export const DEFAULT_MAX_CLIENTS = 100_000

const roll = (window, ms, now) => {
  const elapsed = now - window.start
  if (elapsed < ms) return
  const periods = Math.floor(elapsed / ms)
  window.previous = periods === 1 ? window.current : 0
  window.current = 0
  window.start += periods * ms
}

const estimate = (window, ms, now) => {
  const weight = Math.max(0, (ms - (now - window.start)) / ms)
  return window.previous * weight + window.current
}

export const createRateLimiter = (
  { limits = DEFAULT_LIMITS, maxClients = DEFAULT_MAX_CLIENTS, now = Date.now } = {},
) => {
  const clients = new Map()

  const touch = (ip, at) => {
    let windows = clients.get(ip)
    if (windows) {
      clients.delete(ip)
    } else {
      windows = limits.map(() => ({ start: at, current: 0, previous: 0 }))
    }
    clients.set(ip, windows)
    while (clients.size > maxClients) clients.delete(clients.keys().next().value)
    limits.forEach((limit, index) => roll(windows[index], limit.ms, at))
    return windows
  }

  return {
    exceeded: (ip) => {
      const windows = clients.get(ip)
      if (!windows) return null
      const at = now()
      const current = touch(ip, at)
      const index = limits.findIndex((limit, position) =>
        estimate(current[position], limit.ms, at) >= limit.limit
      )
      return index === -1 ? null : limits[index]
    },
    over: (ip) => {
      const windows = clients.get(ip)
      if (!windows) return null
      const at = now()
      const index = limits.findIndex((limit, position) =>
        estimate(windows[position], limit.ms, at) > limit.limit
      )
      return index === -1 ? null : limits[index]
    },
    add: (ip, amount) => {
      const at = now()
      for (const window of touch(ip, at)) window.current += amount
    },
    size: () => clients.size,
  }
}

export const clientKey = (address) => {
  const plain = address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1')
  if (!plain.includes(':')) return plain
  const [head] = plain.split('%')
  const halves = head.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const missing = Math.max(0, 8 - left.length - right.length)
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  return `${
    groups.slice(0, 4).map((group) => (parseInt(group, 16) || 0).toString(16)).join(':')
  }::/64`
}

export const clientAddress = (request, info, ipHeader) => {
  const remote = info?.remoteAddr?.hostname ?? 'unknown'
  if (!ipHeader) return remote
  const value = request.headers.get(ipHeader)
  if (!value) return remote
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  return entries.at(-1) ?? remote
}
