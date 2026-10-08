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
import { BASE_COLUMNS, isAppName, isSource } from './names.js'
import { join } from './paths.js'
import { nullValues, openLineWriter, openRunReader, openValueReader } from './line-files.js'
import { decodeRuns, encodeValue, splitLines } from './rle.js'
import { SEAL_CHUNK_ROWS, sortDay } from './seal-sort.js'
import { createSummaryBuilder, SUMMARY_FILES } from './summary.js'

export const COMMIT_FILE = 'commit.json'

export const SEALED_META_FILE = 'meta.json'

export const SORT_COLUMNS = ['page', 'type', 'zone', 'name', 'visit']

const GENERATION_PATTERN = /^(raw|sealed)-(\d+)$/

const encoder = new TextEncoder()

const decoder = new TextDecoder()

export const appsDir = (dataDir) => join(dataDir, 'apps')

export const appDir = (dataDir, app) => join(dataDir, 'apps', app)

export const dayDir = (dataDir, app, day) => join(dataDir, 'apps', app, day)

export const sourceDir = (dataDir, app, day, source) => join(dataDir, 'apps', app, day, source)

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

export const listSourcesIn = async (path) =>
  (await listDirectory(path))
    .filter((entry) => entry.isDirectory && isSource(entry.name))
    .map((entry) => entry.name)
    .sort()

export const listSources = (dataDir, app, day) => listSourcesIn(dayDir(dataDir, app, day))

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
  const meta = sealed > 0 ? await readSealedMeta(join(path, `sealed-${sealed}`)) : null
  if (meta?.summaryOnly === true) return null
  return {
    dir: join(path, `raw-${raws.length ? raws.at(-1) : sealed + 1}`),
    appliedWal: meta?.wal ?? 0,
  }
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
    open: async (column) => {
      const bytes = commit.columns[column]
      if (bytes === undefined) return nullValues()
      return await openValueReader(columnPath(dir, column), { maxBytes: bytes })
    },
  }
}

export const readSealedMeta = async (dir) => {
  const meta = await readJson(join(dir, SEALED_META_FILE), null)
  if (meta === null) throw new Deno.errors.NotFound(`${join(dir, SEALED_META_FILE)} is missing`)
  if (
    !Number.isSafeInteger(meta?.rows) || !Number.isSafeInteger(meta?.wal) ||
    !Array.isArray(meta?.columns) || !Array.isArray(meta?.plain)
  ) {
    throw new Error(`${join(dir, SEALED_META_FILE)} is not valid`)
  }
  return meta
}

export const SUMMARY_ONLY_PROBLEM = 'only the daily summary of the day is stored'

const readSealedPart = async (dir) => {
  const meta = await readSealedMeta(dir)
  return {
    rows: meta.rows,
    wal: meta.wal,
    columns: meta.columns,
    read: async (column) => {
      if (meta.summaryOnly === true) throw new Error(SUMMARY_ONLY_PROBLEM)
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
    open: async (column) => {
      if (meta.summaryOnly === true) throw new Error(SUMMARY_ONLY_PROBLEM)
      if (!meta.columns.includes(column)) return nullValues()
      if (meta.plain.includes(column)) return await openValueReader(columnPath(dir, column))
      return await openRunReader(join(dir, `${column}.rle`))
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

const changedDuringRead = async (error, path, before) =>
  error instanceof Deno.errors.NotFound && !sameGenerations(before, await readGenerations(path))

export const readDay = async (path, columns) => {
  for (let attempt = 1;; attempt++) {
    const before = await readGenerations(path)
    try {
      const { parts } = await readDayParts(path, before)
      const rows = parts.reduce((sum, part) => sum + part.rows, 0)
      const values = {}
      for (const column of columns) values[column] = await readColumn(parts, column)
      if (sameGenerations(before, await readGenerations(path))) return { rows, columns: values }
    } catch (error) {
      if (!(await changedDuringRead(error, path, before))) throw error
    }
    if (attempt === READ_ATTEMPTS) throw new Error(`${path} changed during each read`)
    await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
  }
}

export const readDaySummary = async (path, { withVisits, accept = () => true }) => {
  for (let attempt = 1;; attempt++) {
    const before = await readGenerations(path)
    if (before.sealed === 0 || before.raws.length) return null
    try {
      const dir = join(path, `sealed-${before.sealed}`)
      const meta = await readSealedMeta(dir)
      if (meta.summary !== true || !(await accept(meta))) return null
      const read = (kind) => Deno.readTextFile(join(dir, SUMMARY_FILES[kind]))
      const summary = {
        rows: meta.rows,
        wal: meta.wal,
        days: meta.days,
        counts: await read('counts'),
        tuples: withVisits ? await read('tuples') : null,
        visits: withVisits ? await read('visits') : null,
      }
      if (sameGenerations(before, await readGenerations(path))) return summary
    } catch (error) {
      if (!(await changedDuringRead(error, path, before))) throw error
    }
    if (attempt === READ_ATTEMPTS) throw new Error(`${path} changed during each read`)
    await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
  }
}

export const isSummaryOnlyDay = async (path) => {
  const { sealed, raws } = await readGenerations(path)
  if (sealed === 0 || raws.length) return false
  try {
    return (await readSealedMeta(join(path, `sealed-${sealed}`))).summaryOnly === true
  } catch {
    return false
  }
}

const writeSyncedLines = async (path, lines) => {
  const writer = await openLineWriter(path)
  try {
    for (const line of lines) {
      writer.write(line)
      if (writer.full) await writer.flush()
    }
  } catch (error) {
    writer.abort()
    throw error
  }
  await writer.close()
}

const writeSummaryFolder = async (path, generation, { rows, wal, files, days }) => {
  const temporary = join(path, `sealed-${generation}.tmp`)
  await removeIfExists(temporary, { recursive: true })
  await Deno.mkdir(temporary)
  for (const [kind, text] of Object.entries(files)) {
    await writeSyncedLines(join(temporary, SUMMARY_FILES[kind]), [text].flat())
  }
  const meta = { rows, wal, columns: [], plain: [], summary: true, summaryOnly: true }
  if (days) meta.days = days
  await writeFileAtomic(join(temporary, SEALED_META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
  await syncDirectory(temporary)
  await Deno.rename(temporary, join(path, `sealed-${generation}`))
  await syncDirectory(path)
}

export const writeSummaryDay = async (path, { rows, files }) => {
  await Deno.mkdir(path, { recursive: true })
  await tidyDay(path)
  const { sealed, raws } = await readGenerations(path)
  if (sealed > 0 || raws.length) throw new Error(`${path} already holds data`)
  await writeSummaryFolder(path, 1, { rows, wal: 0, files })
}

export const writeSummaryPeriod = async (path, { rows, days, files }) => {
  await Deno.mkdir(path, { recursive: true })
  await tidyDay(path)
  const { sealed, raws } = await readGenerations(path)
  const generation = Math.max(sealed, ...raws) + 1
  await writeSummaryFolder(path, generation, { rows, wal: 0, files, days })
  await tidyDay(path)
}

export const keepOnlySummary = async (path) => {
  await tidyDay(path)
  const { sealed, raws } = await readGenerations(path)
  if (sealed === 0) return false
  const dir = join(path, `sealed-${sealed}`)
  const meta = await readSealedMeta(dir)
  if (meta.summaryOnly === true || meta.summary !== true) return false
  const files = {}
  for (const [kind, file] of Object.entries(SUMMARY_FILES)) {
    files[kind] = await Deno.readTextFile(join(dir, file))
  }
  const generation = Math.max(sealed, ...raws) + 1
  await writeSummaryFolder(path, generation, { rows: meta.rows, wal: meta.wal, files })
  await tidyDay(path)
  return true
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

export const sealDay = async (path, { chunkRows = SEAL_CHUNK_ROWS } = {}) => {
  await tidyDay(path)
  const { sealed, raws, parts } = await readDayParts(path)
  if (!raws.length) return false
  const rawRows = parts.slice(sealed > 0 ? 1 : 0).reduce((sum, part) => sum + part.rows, 0)
  const target = raws.at(-1)
  if (rawRows > 0) {
    const rows = parts.reduce((sum, part) => sum + part.rows, 0)
    const wal = Math.max(...parts.map((part) => part.wal))
    const columns = orderColumns(parts.flatMap((part) => part.columns))
    const rowColumns = orderColumns([...columns, ...SORT_COLUMNS, 'at'])
    const temporary = join(path, `sealed-${target}.tmp`)
    await removeIfExists(temporary, { recursive: true })
    await Deno.mkdir(temporary)
    const summary = createSummaryBuilder({ columns, rowColumns })
    const plain = await sortDay({
      parts,
      rows,
      rowColumns,
      columns,
      sortColumns: SORT_COLUMNS,
      numberColumn: 'at',
      dir: temporary,
      chunkRows,
      onRows: summary.addRows,
    })
    for (const [kind, lines] of Object.entries(summary.finish())) {
      await writeSyncedLines(join(temporary, SUMMARY_FILES[kind]), lines)
    }
    const meta = { rows, wal, columns, plain, summary: true, sortedBy: [...SORT_COLUMNS, 'at'] }
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
