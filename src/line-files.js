import { writeAll } from './fs-utils.js'
import { decodeValue } from './rle.js'

export const READ_BLOCK_BYTES = 262_144

export const WRITE_CHUNK_CHARACTERS = 1_048_576

const encoder = new TextEncoder()

export const openLineReader = async (
  path,
  { maxBytes = Infinity, blockBytes = READ_BLOCK_BYTES } = {},
) => {
  const file = await Deno.open(path, { read: true })
  const buffer = new Uint8Array(blockBytes)
  const decoder = new TextDecoder()
  let remaining = maxBytes
  let pending = ''
  let ended = false
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    file.close()
  }

  const readBlock = async () => {
    while (!ended) {
      const size = remaining > 0
        ? await file.read(buffer.subarray(0, Math.min(buffer.length, remaining)))
        : null
      if (size === null) {
        ended = true
        close()
        pending += decoder.decode()
        if (Number.isFinite(maxBytes) && remaining > 0) {
          throw new Error(`${path} is shorter than its commit`)
        }
        if (pending !== '') throw new Error(`${path} does not end with a line break`)
        return null
      }
      remaining -= size
      const lines = (pending + decoder.decode(buffer.subarray(0, size), { stream: true })).split(
        '\n',
      )
      pending = lines.pop()
      if (lines.length) return lines
    }
    return null
  }

  return { readBlock, close }
}

export const openLineWriter = async (path) => {
  const file = await Deno.open(path, { write: true, create: true, truncate: true })
  let chunk = []
  let size = 0
  const flush = async () => {
    if (!chunk.length) return
    const text = chunk.join('')
    chunk = []
    size = 0
    await writeAll(file, encoder.encode(text))
  }
  return {
    write: (text) => {
      chunk.push(text)
      size += text.length
    },
    get full() {
      return size >= WRITE_CHUNK_CHARACTERS
    },
    flush,
    close: async () => {
      try {
        await flush()
        await file.syncData()
      } finally {
        file.close()
      }
    },
    abort: () => {
      try {
        file.close()
      } catch {
        return
      }
    },
  }
}

export const nullValues = () => ({
  take: (count) => Promise.resolve(new Array(count).fill(null)),
  finish: () => Promise.resolve(),
  close: () => {},
})

const fewerRows = (path) => new Error(`${path} holds fewer rows than expected`)

const moreRows = (path) => new Error(`${path} holds more rows than expected`)

export const openValueReader = async (path, options) => {
  const reader = await openLineReader(path, options)
  let block = []
  let index = 0
  return {
    take: async (count) => {
      const values = new Array(count)
      let filled = 0
      while (filled < count) {
        if (index === block.length) {
          const next = await reader.readBlock()
          if (next === null) throw fewerRows(path)
          block = next
          index = 0
          continue
        }
        const size = Math.min(count - filled, block.length - index)
        for (let offset = 0; offset < size; offset++) {
          values[filled + offset] = decodeValue(block[index + offset])
        }
        filled += size
        index += size
      }
      return values
    },
    finish: async () => {
      if (index < block.length || (await reader.readBlock()) !== null) throw moreRows(path)
    },
    close: reader.close,
  }
}

export const openRunReader = async (path) => {
  const reader = await openLineReader(path)
  let block = []
  let index = 0
  let value = null
  let left = 0
  const nextRun = async () => {
    while (index === block.length) {
      const next = await reader.readBlock()
      if (next === null) throw fewerRows(path)
      block = next
      index = 0
    }
    const line = block[index++]
    const tab = line.indexOf('\t')
    if (tab === -1) throw new Error('a run line has no tab')
    const count = Number(line.slice(0, tab))
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('a run line has a wrong count')
    value = decodeValue(line.slice(tab + 1))
    left = count
  }
  return {
    take: async (count) => {
      const values = new Array(count)
      let filled = 0
      while (filled < count) {
        if (left === 0) await nextRun()
        const size = Math.min(count - filled, left)
        values.fill(value, filled, filled + size)
        filled += size
        left -= size
      }
      return values
    },
    finish: async () => {
      if (left > 0 || index < block.length || (await reader.readBlock()) !== null) {
        throw moreRows(path)
      }
    },
    close: reader.close,
  }
}
