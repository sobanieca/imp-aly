import { absolutePath, dirname, getHome, join } from './paths.js'
import { logger } from './logger.js'
import { sha256Hex } from './sha256.js'

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

export const defaultKeyPath = () => join(getHome(), '.secret', 'imp-aly-key')

const looksLikePath = (value) =>
  value.includes('/') || value.startsWith('~') || value.startsWith('.')

const osReason = (error) => error.message.split(': ')[0]

const isFile = (path) => {
  try {
    return Deno.statSync(path).isFile
  } catch {
    return false
  }
}

export const readKeyFile = (path) => {
  try {
    return Deno.readTextFileSync(path).trim()
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return ''
    throw new Error(`cannot read the key file ${path} (${osReason(error)})`)
  }
}

export const resolveKey = (auth) => {
  const value = String(auth ?? '').trim()
  if (!value) return { key: readKeyFile(defaultKeyPath()), path: defaultKeyPath() }
  if (looksLikePath(value)) {
    const path = absolutePath(value)
    return { key: readKeyFile(path), path }
  }
  if (isFile(value)) return { key: readKeyFile(value), path: absolutePath(value) }
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

export const findOrCreateKey = (auth, defaultPath = defaultKeyPath()) => {
  const { key, path } = resolveKey(auth)
  const target = path || defaultPath
  const saved = readKeyFile(target)
  if (key && key === saved) return { key, path: target }
  if (key && saved) {
    throw new Error(
      `the key file ${target} holds a different key - pass -a ${target}, or remove the file to save the new key`,
    )
  }
  const fresh = key || generateKey()
  try {
    Deno.mkdirSync(dirname(target), { recursive: true })
    Deno.writeTextFileSync(target, `${fresh}\n`, { mode: 0o600 })
  } catch (error) {
    throw new Error(
      `cannot save the key to ${target} (${
        osReason(error)
      }) - pass -a <file> with a path that you can write`,
    )
  }
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
