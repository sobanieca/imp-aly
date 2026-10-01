import {
  listDirectory,
  readJson,
  removeIfExists,
  syncDirectory,
  writeAll,
  writeFileAtomic,
  writeJsonAtomic,
} from './fs-utils.js'
import { isDay } from './days.js'
import { BASE_COLUMNS, isAppName } from './names.js'
import { join } from './paths.js'
import { countRuns, decodeRuns, encodeValue, plainLines, runLines, splitLines } from './rle.js'

export const COMMIT_FILE = 'commit.json'

export const SEALED_META_FILE = 'meta.json'

export const SORT_COLUMNS = ['page', 'type', 'zone', 'name', 'visit']

const GENERATION_PATTERN = /^(raw|sealed)-(\d+)$/

const WRITE_CHUNK_CHARACTERS = 1_048_576

const encoder = new TextEncoder()

const decoder = new TextDecoder()

export const appsDir = (dataDir) => join(dataDir, 'apps')

export const appDir = (dataDir, app) => join(dataDir, 'apps', app)

export const dayDir = (dataDir, app, day) => join(dataDir, 'apps', app, day)

export const orderColumns = (columns) => {
  const unique = new Set(columns)
  const base = BASE_COLUMNS.filter((column) => unique.has(column))
  const segments = [...unique].filter((column) => !BASE_COLUMNS.includes(column)).sort()
  return [...base, ...segments]
}

export const listApps = async (dataDir) =>
  (await listDirectory(appsDir(dataDir)))
    .filter((entry) => entry.isDirectory && isAppName(entry.name))
    .map((entry) => entry.name)
    .sort()

export const listDays = async (dataDir, app) =>
  (await listDirectory(appDir(dataDir, app)))
    .filter((entry) => entry.isDirectory && isDay(entry.name))
    .map((entry) => entry.name)
    .sort()

export const readGenerations = async (path) => {
  const sealedAll = []
  const rawAll = []
  const temporary = []
  for (const entry of await listDirectory(path)) {
    if (!entry.isDirectory) continue
    if (entry.name.endsWith('.tmp')) {
      temporary.push(entry.name)
      continue
    }
    const match = GENERATION_PATTERN.exec(entry.name)
    if (!match) continue
    if (match[1] === 'sealed') sealedAll.push(Number(match[2]))
    else rawAll.push(Number(match[2]))
  }
  const sealed = sealedAll.length ? Math.max(...sealedAll) : 0
  return {
    sealed,
    raws: rawAll.filter((generation) => generation > sealed).sort((a, b) => a - b),
    staleSealed: sealedAll.filter((generation) => generation < sealed),
    staleRaws: rawAll.filter((generation) => generation <= sealed),
    temporary,
  }
}

export const appendTarget = async (path) => {
  const { sealed, raws } = await readGenerations(path)
  const appliedWal = sealed > 0 ? (await readSealedPart(join(path, `sealed-${sealed}`))).wal : 0
  return { dir: join(path, `raw-${raws.length ? raws.at(-1) : sealed + 1}`), appliedWal }
}

const EMPTY_COMMIT = { rows: 0, wal: 0, columns: {} }

export const readCommit = async (dir) => {
  const commit = await readJson(join(dir, COMMIT_FILE), EMPTY_COMMIT)
  if (
    !Number.isSafeInteger(commit?.rows) || !Number.isSafeInteger(commit?.wal) ||
    commit.columns === null || typeof commit.columns !== 'object'
  ) {
    throw new Error(`${join(dir, COMMIT_FILE)} is not a valid commit`)
  }
  return commit
}

const columnPath = (dir, column) => join(dir, `${column}.txt`)

export const appendRecords = async ({ dir, segment, records, appliedWal = 0 }) => {
  await Deno.mkdir(dir, { recursive: true })
  const commit = await readCommit(dir)
  if (Math.max(commit.wal, appliedWal) >= segment) return false
  const keys = new Set(Object.keys(commit.columns))
  for (const record of records) for (const key of Object.keys(record)) keys.add(key)
  const columns = orderColumns(keys)
  const opened = []
  const sizes = {}
  const closeAll = () => {
    for (const entry of opened) {
      if (entry.open) {
        entry.open = false
        entry.file.close()
      }
    }
  }
  try {
    for (const column of columns) {
      const committed = commit.columns[column]
      const file = await Deno.open(columnPath(dir, column), { write: true, create: true })
      opened.push({ column, file, committed, open: true })
      await file.truncate(committed ?? 0)
      await file.seek(0, Deno.SeekMode.End)
      const prefix = committed === undefined ? '\n'.repeat(commit.rows) : ''
      const text = prefix + records.map((record) => `${encodeValue(record[column])}\n`).join('')
      const bytes = encoder.encode(text)
      await writeAll(file, bytes)
      await file.syncData()
      sizes[column] = (committed ?? 0) + bytes.length
    }
    closeAll()
    await writeJsonAtomic(join(dir, COMMIT_FILE), {
      rows: commit.rows + records.length,
      wal: segment,
      columns: sizes,
    })
  } catch (error) {
    closeAll()
    await revertAppend(dir, opened)
    throw error
  }
  return true
}

const revertAppend = async (dir, opened) => {
  for (const { column, committed } of opened) {
    try {
      if (committed === undefined) await removeIfExists(columnPath(dir, column))
      else await Deno.truncate(columnPath(dir, column), committed)
    } catch {
      continue
    }
  }
}

const nullColumn = (rows) => new Array(rows).fill(null)

const readRawPart = async (dir) => {
  const commit = await readCommit(dir)
  return {
    rows: commit.rows,
    wal: commit.wal,
    columns: Object.keys(commit.columns),
    read: async (column) => {
      const bytes = commit.columns[column]
      if (bytes === undefined) return nullColumn(commit.rows)
      const data = await Deno.readFile(columnPath(dir, column))
      if (data.length < bytes) {
        throw new Error(`${columnPath(dir, column)} is shorter than its commit`)
      }
      const values = splitLines(decoder.decode(data.subarray(0, bytes)))
      if (values.length !== commit.rows) {
        throw new Error(
          `${columnPath(dir, column)} holds ${values.length} rows, expected ${commit.rows}`,
        )
      }
      return values
    },
  }
}

const readSealedPart = async (dir) => {
  const meta = await readJson(join(dir, SEALED_META_FILE), null)
  if (meta === null) throw new Deno.errors.NotFound(`${join(dir, SEALED_META_FILE)} is missing`)
  if (
    !Number.isSafeInteger(meta?.rows) || !Number.isSafeInteger(meta?.wal) ||
    !Array.isArray(meta?.columns) || !Array.isArray(meta?.plain)
  ) {
    throw new Error(`${join(dir, SEALED_META_FILE)} is not valid`)
  }
  return {
    rows: meta.rows,
    wal: meta.wal,
    columns: meta.columns,
    read: async (column) => {
      if (!meta.columns.includes(column)) return nullColumn(meta.rows)
      if (!meta.plain.includes(column)) {
        return decodeRuns(await Deno.readTextFile(join(dir, `${column}.rle`)), meta.rows)
      }
      const values = splitLines(await Deno.readTextFile(columnPath(dir, column)))
      if (values.length !== meta.rows) {
        throw new Error(
          `${columnPath(dir, column)} holds ${values.length} rows, expected ${meta.rows}`,
        )
      }
      return values
    },
  }
}

export const readDayParts = async (path, generations) => {
  const { sealed, raws } = generations ?? (await readGenerations(path))
  const parts = []
  if (sealed > 0) parts.push(await readSealedPart(join(path, `sealed-${sealed}`)))
  for (const generation of raws) parts.push(await readRawPart(join(path, `raw-${generation}`)))
  return { sealed, raws, parts }
}

export const readColumn = async (parts, column) => {
  if (parts.length === 1) return await parts[0].read(column)
  const values = []
  for (const part of parts) {
    for (const value of await part.read(column)) values.push(value)
  }
  return values
}

const READ_ATTEMPTS = 5

const sameGenerations = (a, b) => a.sealed === b.sealed && a.raws.join() === b.raws.join()

export const readDay = async (path, columns) => {
  for (let attempt = 1;; attempt++) {
    try {
      const before = await readGenerations(path)
      const { parts } = await readDayParts(path, before)
      const rows = parts.reduce((sum, part) => sum + part.rows, 0)
      const values = {}
      for (const column of columns) values[column] = await readColumn(parts, column)
      if (sameGenerations(before, await readGenerations(path))) return { rows, columns: values }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
    if (attempt === READ_ATTEMPTS) throw new Error(`${path} changed during each read`)
    await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
  }
}

const compareText = (a, b) => {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}

const rankValues = (values) => {
  const sorted = [...new Set(values)].sort(compareText)
  const rankOf = new Map(sorted.map((value, index) => [value, index]))
  const ranks = new Uint32Array(values.length)
  for (let index = 0; index < values.length; index++) ranks[index] = rankOf.get(values[index])
  return ranks
}

const sortOrder = async (parts, rows) => {
  const keys = []
  for (const column of SORT_COLUMNS) keys.push(rankValues(await readColumn(parts, column)))
  const atValues = await readColumn(parts, 'at')
  const at = new Float64Array(rows)
  for (let index = 0; index < rows; index++) at[index] = Number(atValues[index] ?? 0)
  const order = new Uint32Array(rows)
  for (let index = 0; index < rows; index++) order[index] = index
  order.sort((a, b) => {
    for (const key of keys) {
      const difference = key[a] - key[b]
      if (difference !== 0) return difference
    }
    return at[a] - at[b] || a - b
  })
  return order
}

const writeSyncedLines = async (path, lines) => {
  const file = await Deno.open(path, { write: true, create: true, truncate: true })
  try {
    let chunk = []
    let size = 0
    for (const line of lines) {
      chunk.push(line)
      size += line.length
      if (size >= WRITE_CHUNK_CHARACTERS) {
        await writeAll(file, encoder.encode(chunk.join('')))
        chunk = []
        size = 0
      }
    }
    if (chunk.length) await writeAll(file, encoder.encode(chunk.join('')))
    await file.syncData()
  } finally {
    file.close()
  }
}

export const tidyDay = async (path) => {
  const { staleSealed, staleRaws, temporary } = await readGenerations(path)
  for (const name of temporary) await removeIfExists(join(path, name), { recursive: true })
  for (const generation of staleSealed) {
    await removeIfExists(join(path, `sealed-${generation}`), { recursive: true })
  }
  for (const generation of staleRaws) {
    await removeIfExists(join(path, `raw-${generation}`), { recursive: true })
  }
}

export const sealDay = async (path) => {
  await tidyDay(path)
  const { sealed, raws, parts } = await readDayParts(path)
  if (!raws.length) return false
  const rawRows = parts.slice(sealed > 0 ? 1 : 0).reduce((sum, part) => sum + part.rows, 0)
  const target = raws.at(-1)
  if (rawRows > 0) {
    const rows = parts.reduce((sum, part) => sum + part.rows, 0)
    const wal = Math.max(...parts.map((part) => part.wal))
    const columns = orderColumns(parts.flatMap((part) => part.columns))
    const order = await sortOrder(parts, rows)
    const temporary = join(path, `sealed-${target}.tmp`)
    await removeIfExists(temporary, { recursive: true })
    await Deno.mkdir(temporary)
    const plain = []
    for (const column of columns) {
      const values = await readColumn(parts, column)
      if (countRuns(values, order) * 2 > rows) {
        plain.push(column)
        await writeSyncedLines(columnPath(temporary, column), plainLines(values, order))
      } else {
        await writeSyncedLines(join(temporary, `${column}.rle`), runLines(values, order))
      }
    }
    const meta = { rows, wal, columns, plain, sortedBy: [...SORT_COLUMNS, 'at'] }
    await writeFileAtomic(join(temporary, SEALED_META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
    await syncDirectory(temporary)
    await Deno.rename(temporary, join(path, `sealed-${target}`))
    await syncDirectory(path)
    if (sealed > 0) await removeIfExists(join(path, `sealed-${sealed}`), { recursive: true })
  }
  for (const generation of raws) {
    await removeIfExists(join(path, `raw-${generation}`), { recursive: true })
  }
  return rawRows > 0
}
