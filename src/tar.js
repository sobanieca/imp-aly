export const BLOCK_BYTES = 512

const NAME_BYTES = 100

const PREFIX_BYTES = 155

const encoder = new TextEncoder()

const decoder = new TextDecoder()

const writeText = (block, offset, text) => block.set(encoder.encode(text), offset)

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`

export const tarHeader = ({ name, size, mtimeMs }) => {
  const bytes = encoder.encode(name)
  if (bytes.length > NAME_BYTES) throw new Error(`the archive name ${name} is too long`)
  const block = new Uint8Array(BLOCK_BYTES)
  block.set(bytes, 0)
  writeText(block, 100, octal(0o644, 8))
  writeText(block, 108, octal(0, 8))
  writeText(block, 116, octal(0, 8))
  writeText(block, 124, octal(size, 12))
  writeText(block, 136, octal(Math.floor(mtimeMs / 1000), 12))
  writeText(block, 148, ' '.repeat(8))
  writeText(block, 156, '0')
  writeText(block, 257, 'ustar\0')
  writeText(block, 263, '00')
  const sum = block.reduce((total, byte) => total + byte, 0)
  writeText(block, 148, `${sum.toString(8).padStart(6, '0')}\0 `)
  return block
}

export const tarPadding = (size) =>
  new Uint8Array((BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES)

export const tarEnd = () => new Uint8Array(BLOCK_BYTES * 2)

export function* tarEntry({ name, data, mtimeMs }) {
  yield tarHeader({ name, size: data.length, mtimeMs })
  yield data
  const padding = tarPadding(data.length)
  if (padding.length) yield padding
}

const createByteReader = (stream) => {
  const reader = stream.getReader()
  const chunks = []
  let buffered = 0
  let done = false

  const fill = async (needed) => {
    while (buffered < needed && !done) {
      const result = await reader.read()
      if (result.done) done = true
      else if (result.value.length) {
        chunks.push(result.value)
        buffered += result.value.length
      }
    }
  }

  return {
    read: async (size) => {
      await fill(size)
      if (buffered === 0 && size > 0) return null
      if (buffered < size) throw new Error('the archive ends in the middle of a file')
      const bytes = new Uint8Array(size)
      let offset = 0
      while (offset < size) {
        const chunk = chunks[0]
        const take = Math.min(chunk.length, size - offset)
        bytes.set(chunk.subarray(0, take), offset)
        offset += take
        if (take === chunk.length) chunks.shift()
        else chunks[0] = chunk.subarray(take)
      }
      buffered -= size
      return bytes
    },
    cancel: () => reader.cancel().catch(() => {}),
  }
}

const field = (block, offset, length) => {
  const bytes = block.subarray(offset, offset + length)
  const end = bytes.indexOf(0)
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
}

const readOctal = (block, offset, length) => {
  const text = field(block, offset, length).trim()
  if (!/^[0-7]+$/.test(text)) throw new Error('the archive has a header that is not valid')
  return parseInt(text, 8)
}

const checkHeader = (block) => {
  const stored = readOctal(block, 148, 8)
  let sum = 0
  for (let index = 0; index < BLOCK_BYTES; index++) {
    sum += index >= 148 && index < 156 ? 32 : block[index]
  }
  if (sum !== stored) throw new Error('the archive has a header with a wrong checksum')
}

export async function* readTar(stream, { maxEntryBytes }) {
  const reader = createByteReader(stream)
  try {
    while (true) {
      const block = await reader.read(BLOCK_BYTES)
      if (block === null || block.every((byte) => byte === 0)) return
      checkHeader(block)
      const type = String.fromCharCode(block[156])
      const size = readOctal(block, 124, 12)
      const prefix = field(block, 345, PREFIX_BYTES)
      const name = (prefix ? `${prefix}/` : '') + field(block, 0, NAME_BYTES)
      if (size > maxEntryBytes) {
        throw new Error(`the archive entry ${name} is larger than ${maxEntryBytes} bytes`)
      }
      const data = await reader.read(size)
      if (data === null) throw new Error('the archive ends in the middle of a file')
      await reader.read(tarPadding(size).length)
      if (type === '0' || type === '\0') yield { name: name.replace(/^(\.\/)+/, ''), data }
    }
  } finally {
    await reader.cancel()
  }
}
