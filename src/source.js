import { readJson, writeJsonAtomic } from './fs-utils.js'
import { isSource } from './names.js'
import { join } from './paths.js'

export const SOURCE_FILE = 'source.json'

export const newSource = () =>
  [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

export const openSource = async (dataDir) => {
  const path = join(dataDir, SOURCE_FILE)
  const stored = await readJson(path, null)
  if (stored === null) {
    const source = newSource()
    await writeJsonAtomic(path, { source })
    return source
  }
  if (!isSource(stored?.source)) {
    throw new Error(`${path} does not hold a source id of 16 hex digits`)
  }
  return stored.source
}
