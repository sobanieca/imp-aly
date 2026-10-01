import { dirname } from './paths.js'

const encoder = new TextEncoder()

export const writeAll = async (file, bytes) => {
  let offset = 0
  while (offset < bytes.length) {
    offset += await file.write(bytes.subarray(offset))
  }
}

export const syncDirectory = async (path) => {
  const directory = await Deno.open(path, { read: true })
  try {
    await directory.sync()
  } finally {
    directory.close()
  }
}

export const writeFileAtomic = async (path, text) => {
  const temporary = `${path}.tmp`
  const file = await Deno.open(temporary, { write: true, create: true, truncate: true })
  try {
    await writeAll(file, encoder.encode(text))
    await file.syncData()
  } finally {
    file.close()
  }
  await Deno.rename(temporary, path)
  await syncDirectory(dirname(path))
}

export const writeJsonAtomic = (path, value) =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)

export const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await Deno.readTextFile(path))
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return fallback
    throw error
  }
}

export const removeIfExists = async (path, options = {}) => {
  try {
    await Deno.remove(path, options)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  }
}

export const listDirectory = async (path) => {
  const entries = []
  try {
    for await (const entry of Deno.readDir(path)) entries.push(entry)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return []
    throw error
  }
  return entries
}
