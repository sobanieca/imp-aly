import { inNetwork, parseIp, parseNetwork } from './ip.js'

export const DEFAULT_LIMITS = [
  { name: '5s', ms: 5_000, limit: 200 },
  { name: '1m', ms: 60_000, limit: 1_500 },
  { name: '1h', ms: 3_600_000, limit: 30_000 },
  { name: '24h', ms: 86_400_000, limit: 200_000 },
]

export const DEFAULT_MAX_CLIENTS = 400_000

export const NETWORK_SCALE = 16

export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.0/8', '::1']

const PERIOD = 0
const CURRENT = 1
const PREVIOUS = 2
const FIELDS = 3
const FIRST_SLOTS = 1024

const createSlab = (width, capacity) => {
  let counts = new Uint32Array(width * Math.min(capacity, FIRST_SLOTS))
  let used = 0
  return {
    counts: () => counts,
    add: () => {
      if ((used + 1) * width > counts.length) {
        const larger = new Uint32Array(width * Math.min(capacity, (used + 1) * 2))
        larger.set(counts)
        counts = larger
      }
      return used++
    },
  }
}

export const createRateLimiter = (
  { limits = DEFAULT_LIMITS, maxClients = DEFAULT_MAX_CLIENTS, now = Date.now } = {},
) => {
  const generation = Math.max(1, Math.ceil(maxClients / 2))
  const width = limits.length * FIELDS
  let recent = { slots: new Map(), slab: createSlab(width, generation) }
  let older = { slots: new Map(), slab: createSlab(width, 0) }

  const insert = (key) => {
    if (recent.slots.size >= generation) {
      older = recent
      recent = { slots: new Map(), slab: createSlab(width, generation) }
    }
    const slot = recent.slab.add()
    recent.slots.set(key, slot)
    return slot * width
  }

  const find = (key) => {
    const slot = recent.slots.get(key)
    if (slot !== undefined) return slot * width
    const oldSlot = older.slots.get(key)
    if (oldSlot === undefined) return null
    older.slots.delete(key)
    const source = older.slab.counts()
    const base = insert(key)
    recent.slab.counts().set(source.subarray(oldSlot * width, (oldSlot + 1) * width), base)
    return base
  }

  const roll = (counts, offset, period) => {
    const last = counts[offset + PERIOD]
    if (last === period) return
    counts[offset + PREVIOUS] = ((period - last) >>> 0) === 1 ? counts[offset + CURRENT] : 0
    counts[offset + CURRENT] = 0
    counts[offset + PERIOD] = period
  }

  const update = (base, at) => {
    const counts = recent.slab.counts()
    for (const [position, limit] of limits.entries()) {
      roll(counts, base + position * FIELDS, Math.floor(at / limit.ms) >>> 0)
    }
    return counts
  }

  const estimate = (counts, offset, ms, at) =>
    counts[offset + PREVIOUS] * ((ms - (at % ms)) / ms) + counts[offset + CURRENT]

  return {
    take: (clients, amount) => {
      const at = now()
      for (const client of clients) {
        const base = find(client.key)
        if (base === null) continue
        const counts = update(base, at)
        for (const [position, limit] of limits.entries()) {
          const offset = base + position * FIELDS
          if (estimate(counts, offset, limit.ms, at) + amount > limit.limit * client.scale) {
            return limit
          }
        }
      }
      for (const client of clients) {
        const base = find(client.key) ?? insert(client.key)
        const counts = update(base, at)
        for (const position of limits.keys()) counts[base + position * FIELDS + CURRENT] += amount
      }
      return null
    },
    size: () => recent.slots.size + older.slots.size,
  }
}

export const maxBatch = (limits) => Math.min(...limits.map((limit) => limit.limit))

export const clientKeys = (address) => {
  const ip = parseIp(address)
  if (!ip) return [{ key: address, scale: 1 }]
  const [a, b, c, d] = ip.parts
  if (ip.version === 4) return [{ key: `${a}.${b}.${c}.${d}`, scale: 1 }]
  const network = `${a.toString(16)}:${b.toString(16)}:${c.toString(16)}`
  return [
    { key: `${network}:${d.toString(16)}::/64`, scale: 1 },
    { key: `${network}::/48`, scale: NETWORK_SCALE },
  ]
}

export const parseTrustedProxies = (list) => list.map((entry) => parseNetwork(entry))

export const clientAddress = (request, info, { ipHeader = null, trustedProxies = [] } = {}) => {
  const remote = info?.remoteAddr?.hostname ?? 'unknown'
  if (!ipHeader) return remote
  const remoteIp = parseIp(remote)
  if (!trustedProxies.some((network) => inNetwork(remoteIp, network))) return remote
  const value = request.headers.get(ipHeader)
  if (!value) return remote
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  return entries.at(-1) ?? remote
}
