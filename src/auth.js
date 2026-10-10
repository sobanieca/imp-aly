import { absolutePath, dirname, getHome, join } from './paths.js'
import { logger } from './logger.js'

const KEY_LENGTH = 32

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

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

export const NEW_KEY_FILE = 'new-key'

export const KEY_LOADED_FILE = 'key-loaded'

const HANDOVER_DIR_MODE = 0o750

const HANDOVER_FILE_MODE = 0o640

export const removeFile = (path) => {
  try {
    Deno.removeSync(path)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
}

export const writeKeyFile = (path, key, { mode = 0o600, beforeRename = () => {} } = {}) => {
  const temporary = `${path}.tmp`
  removeFile(temporary)
  Deno.writeTextFileSync(temporary, `${key}\n`, { mode, createNew: true })
  beforeRename(temporary)
  Deno.renameSync(temporary, path)
}

const prepareHandoverDir = (dir, { uid, gid }) => {
  try {
    Deno.mkdirSync(dir, { mode: HANDOVER_DIR_MODE })
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error
  }
  const info = Deno.lstatSync(dir)
  if (!info.isDirectory || info.uid !== uid) {
    throw new Error(`${dir} must be a folder of the user ${uid} - remove it, then try again`)
  }
  Deno.chownSync(dir, uid, gid)
  Deno.chmodSync(dir, HANDOVER_DIR_MODE)
}

export const handOverKey = ({ dir, key, uid, gid }) => {
  prepareHandoverDir(dir, { uid, gid })
  const path = join(dir, NEW_KEY_FILE)
  writeKeyFile(path, key, {
    mode: HANDOVER_FILE_MODE,
    beforeRename: (temporary) => {
      Deno.chownSync(temporary, uid, gid)
      Deno.chmodSync(temporary, HANDOVER_FILE_MODE)
    },
  })
  return path
}

export const takeNewKey = ({ handoverDir, dataDir }, apply) => {
  const key = readKeyFile(join(handoverDir, NEW_KEY_FILE))
  if (!key) return ''
  apply(key)
  Deno.writeTextFileSync(join(dataDir, KEY_LOADED_FILE), `${new Date().toISOString()}\n`)
  return key
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
    writeKeyFile(target, fresh)
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
