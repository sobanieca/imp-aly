import { listDirectory, syncDirectory, writeAll, writeFileAtomic } from './fs-utils.js'
import { join } from './paths.js'

export const SEGMENT_PATTERN = /^(\d{16})(?:-(\d+))?\.(log|open)$/

export const APPLIED_FILE = 'applied'

export const DEFAULT_SEGMENT_MS = 2_000

export const DEFAULT_SEGMENT_BYTES = 8_388_608

const encoder = new TextEncoder()

export const segmentFileName = (id, extension, validBytes) =>
  `${String(id).padStart(16, '0')}${validBytes === undefined ? '' : `-${validBytes}`}.${extension}`

export const readAppliedSegment = async (walDir) => {
  try {
    const value = Number((await Deno.readTextFile(join(walDir, APPLIED_FILE))).trim())
    return Number.isSafeInteger(value) && value > 0 ? value : 0
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0
    throw error
  }
}

export const writeAppliedSegment = (walDir, id) =>
  writeFileAtomic(join(walDir, APPLIED_FILE), `${id}\n`)

export const listClosedSegments = async (walDir) => {
  const segments = []
  for (const entry of await listDirectory(walDir)) {
    const match = SEGMENT_PATTERN.exec(entry.name)
    if (entry.isFile && match && match[3] === 'log') {
      segments.push({
        id: Number(match[1]),
        path: join(walDir, entry.name),
        validBytes: match[2] === undefined ? null : Number(match[2]),
      })
    }
  }
  return segments.sort((a, b) => a.id - b.id)
}

export const openWal = async ({
  dir,
  segmentMs = DEFAULT_SEGMENT_MS,
  segmentBytes = DEFAULT_SEGMENT_BYTES,
  onSegment = () => {},
  now = Date.now,
  log = null,
}) => {
  await Deno.mkdir(dir, { recursive: true })
  let lastId = await readAppliedSegment(dir)
  for (const entry of await listDirectory(dir)) {
    const match = SEGMENT_PATTERN.exec(entry.name)
    if (!entry.isFile || !match) continue
    const id = Number(match[1])
    lastId = Math.max(lastId, id)
    if (match[3] === 'open') {
      await Deno.rename(join(dir, entry.name), join(dir, segmentFileName(id, 'log')))
    }
  }

  let file = null
  let fileId = 0
  let size = 0
  let broken = false
  let pending = []
  let flushQueued = false
  let closed = false
  let chain = Promise.resolve()

  const enqueue = (task) => {
    const run = chain.then(task)
    chain = run.catch(() => {})
    return run
  }

  const openSegment = async () => {
    fileId = Math.max(lastId + 1, now())
    lastId = fileId
    file = await Deno.open(join(dir, segmentFileName(fileId, 'open')), {
      write: true,
      create: true,
      truncate: true,
    })
    await syncDirectory(dir)
    size = 0
    broken = false
  }

  const closeSegment = async () => {
    if (!file) return
    const openPath = join(dir, segmentFileName(fileId, 'open'))
    const stored = broken || size > 0
    if (broken) {
      await Deno.rename(openPath, join(dir, segmentFileName(fileId, 'log', size)))
    } else if (stored) {
      await Deno.rename(openPath, join(dir, segmentFileName(fileId, 'log')))
    } else {
      await Deno.remove(openPath)
    }
    file.close()
    file = null
    size = 0
    broken = false
    if (stored) onSegment(fileId)
  }

  const warnClose = (error) =>
    log?.error(`Cannot close log part ${fileId}, the server tries again later: ${error.message}`)

  const writeBatch = async (text) => {
    if (broken) await closeSegment()
    if (!file) await openSegment()
    const bytes = encoder.encode(text)
    const start = size
    try {
      await writeAll(file, bytes)
      await file.syncData()
      size += bytes.length
    } catch (error) {
      broken = await file.truncate(start)
        .then(() => file.seek(start, Deno.SeekMode.Start))
        .then(() => false, () => true)
      await closeSegment().catch(warnClose)
      throw error
    }
    if (size >= segmentBytes) await closeSegment().catch(warnClose)
  }

  const flushPending = async () => {
    flushQueued = false
    const batch = pending
    pending = []
    if (!batch.length) return
    try {
      await writeBatch(batch.map((entry) => entry.text).join(''))
      for (const entry of batch) entry.resolve()
    } catch (error) {
      for (const entry of batch) entry.reject(error)
    }
  }

  const timer = setInterval(() => {
    if (file && (size > 0 || broken)) enqueue(closeSegment).catch(warnClose)
  }, segmentMs)

  return {
    append: (text) => {
      if (closed) return Promise.reject(new Error('the write-ahead log is closed'))
      return new Promise((resolve, reject) => {
        pending.push({ text, resolve, reject })
        if (!flushQueued) {
          flushQueued = true
          enqueue(flushPending)
        }
      })
    },
    close: async () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      await enqueue(flushPending)
      await enqueue(closeSegment).catch((error) => {
        log?.error(`Cannot close log part ${fileId}, the next start stores it: ${error.message}`)
        file?.close()
        file = null
      })
    },
  }
}
