import { sha256Hex } from './sha256.js'

const NONCE_BYTES = 12

export const TOKEN_TTL_MS = 60_000

const encoder = new TextEncoder()

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export const importSigningKey = (key, extractable = false) =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    extractable,
    ['sign'],
  )

const sign = async (key, text) => {
  const cryptoKey = typeof key === 'string' ? await importSigningKey(key) : key
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(text))
  return toHex(new Uint8Array(mac))
}

export const EMPTY_BODY_HASH = sha256Hex(new Uint8Array(0))

const HASH_PATTERN = /^[0-9a-f]{64}$/

export const requestTarget = (path) => {
  const url = new URL(path, 'http://imp-aly')
  return `${url.pathname}${url.search}`
}

const signedText = ({ timestamp, nonce, method, target, bodyHash }) =>
  [timestamp, nonce, method.toUpperCase(), target, bodyHash].join('\n')

export const createToken = async (key, { method, path, bodyHash = EMPTY_BODY_HASH }) => {
  const timestamp = String(Date.now())
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)))
  const mac = await sign(
    key,
    signedText({ timestamp, nonce, method, target: requestTarget(path), bodyHash }),
  )
  return `${timestamp}.${nonce}.${bodyHash}.${mac}`
}

export const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bytesA = encoder.encode(a)
  const bytesB = encoder.encode(b)
  let difference = bytesA.length ^ bytesB.length
  for (let index = 0; index < Math.max(bytesA.length, bytesB.length); index++) {
    difference |= (bytesA[index] ?? 0) ^ (bytesB[index] ?? 0)
  }
  return difference === 0
}

export const createTokenVerifier = (key, ttlMs = TOKEN_TTL_MS) => {
  const used = new Map()
  return async (token, { method, target }) => {
    const [timestamp, nonce, bodyHash, mac, ...rest] = String(token ?? '').split('.')
    const time = Number(timestamp)
    if (
      !nonce || !mac || rest.length || !Number.isSafeInteger(time) || !HASH_PATTERN.test(bodyHash)
    ) {
      return { problem: 'malformed token' }
    }
    const now = Date.now()
    for (const [usedNonce, expires] of used) if (expires <= now) used.delete(usedNonce)
    if (Math.abs(now - time) > ttlMs) {
      return { problem: 'token expired (check the clock on both machines)' }
    }
    const expected = await sign(key, signedText({ timestamp, nonce, method, target, bodyHash }))
    if (!safeEqual(mac, expected)) return { problem: 'wrong key, or a token for another request' }
    if (used.has(nonce)) return { problem: 'token already used' }
    used.set(nonce, now + 2 * ttlMs)
    return { problem: '', bodyHash }
  }
}
