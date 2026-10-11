import { sha256Hex } from './sha256.js'

const NONCE_BYTES = 12

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

const requestTarget = (path) => {
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
