import { absolutePath, dirname, getHome, join } from './paths.js'
import { logger } from './logger.js'

const KEY_LENGTH = 32

const NONCE_BYTES = 12

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

export const TOKEN_TTL_MS = 60_000

const encoder = new TextEncoder()

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export const generateKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH * 2))
  const usable = Array.from(bytes).filter((byte) => byte < 248)
  if (usable.length < KEY_LENGTH) return generateKey()
  return usable.slice(0, KEY_LENGTH).map((byte) => ALPHABET[byte % ALPHABET.length]).join('')
}

export const defaultKeyPath = () => join(getHome(), '.secret', 'imp-analytics-server-key')

const looksLikePath = (value) =>
  value.includes('/') || value.startsWith('~') || value.startsWith('.')

export const readKeyFile = (path) => {
  try {
    return Deno.readTextFileSync(path).trim()
  } catch {
    return ''
  }
}

export const resolveKey = (auth) => {
  const value = String(auth ?? '').trim()
  if (!value) return { key: readKeyFile(defaultKeyPath()), path: defaultKeyPath() }
  if (looksLikePath(value)) {
    const path = absolutePath(value)
    return { key: readKeyFile(path), path }
  }
  const fromFile = readKeyFile(value)
  if (fromFile) return { key: fromFile, path: absolutePath(value) }
  return { key: value, path: '' }
}

export const findKey = (auth) => {
  const { key, path } = resolveKey(auth)
  if (!key) {
    throw new Error(
      `the key file ${path} is missing or empty - save the key that the server prints there, or pass -a <key>`,
    )
  }
  return key
}

export const findOrCreateKey = (auth) => {
  const { key, path } = resolveKey(auth)
  const target = path || defaultKeyPath()
  if (key && key === readKeyFile(target)) return { key, path: target }
  const fresh = key || generateKey()
  Deno.mkdirSync(dirname(target), { recursive: true })
  Deno.writeTextFileSync(target, `${fresh}\n`, { mode: 0o600 })
  logger.info(`Key saved to ${target}`)
  return { key: fresh, path: target }
}

const sign = async (key, text) => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(text))
  return toHex(new Uint8Array(mac))
}

export const createToken = async (key) => {
  const timestamp = Date.now()
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)))
  return `${timestamp}.${nonce}.${await sign(key, `${timestamp}.${nonce}`)}`
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
  return async (token) => {
    const [timestampText, nonce, mac, ...rest] = String(token ?? '').split('.')
    const timestamp = Number(timestampText)
    if (!nonce || !mac || rest.length || !Number.isSafeInteger(timestamp)) {
      return 'malformed token'
    }
    const now = Date.now()
    for (const [usedNonce, expires] of used) if (expires <= now) used.delete(usedNonce)
    if (Math.abs(now - timestamp) > ttlMs) {
      return 'token expired (check the clock on both machines)'
    }
    if (!safeEqual(mac, await sign(key, `${timestampText}.${nonce}`))) return 'wrong key'
    if (used.has(nonce)) return 'token already used'
    used.set(nonce, now + 2 * ttlMs)
    return ''
  }
}
