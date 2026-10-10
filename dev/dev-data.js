import { generateKey, readKeyFile, writeKeyFile } from '../src/auth.js'
import { join } from '../src/paths.js'

export const DEV_DATA_DIR = decodeURIComponent(new URL('../.dev-data', import.meta.url).pathname)

const exists = async (path) => {
  try {
    await Deno.stat(path)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  }
}

export const openDevData = async (root = DEV_DATA_DIR, { reset = false } = {}) => {
  const dataDir = join(root, 'data')
  const keyPath = join(root, 'key')
  if (reset) await Deno.remove(root, { recursive: true }).catch(() => {})
  const key = (await exists(dataDir)) ? readKeyFile(keyPath) : ''
  if (key) return { root, dataDir, key, fresh: false }
  await Deno.remove(dataDir, { recursive: true }).catch(() => {})
  await Deno.mkdir(dataDir, { recursive: true })
  const created = generateKey()
  writeKeyFile(keyPath, created)
  return { root, dataDir, key: created, fresh: true }
}
