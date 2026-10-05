import { readJson, writeJsonAtomic } from './fs-utils.js'
import { join } from './paths.js'
import { version } from './version.js'

export const DATA_FORMAT = 1

export const FORMAT_FILE = 'format.json'

export const checkDataFormat = async (dataDir) => {
  const path = join(dataDir, FORMAT_FILE)
  const stored = await readJson(path, null)
  if (stored === null) {
    await writeJsonAtomic(path, { format: DATA_FORMAT })
    return
  }
  if (stored?.format === DATA_FORMAT) return
  throw new Error(
    `the data folder ${dataDir} has the data format ${
      JSON.stringify(stored?.format)
    }, and imp-aly ${version} reads only the format ${DATA_FORMAT} - install a version of imp-aly that reads it`,
  )
}
