export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const readBodyBytes = async (request, { maxBytes, timeoutMs = 10_000 }) => {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => {})
    throw new HttpError(413, `the body is larger than ${maxBytes} bytes`)
  }
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    reader.cancel().catch(() => {})
  }, timeoutMs)
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new HttpError(413, `the body is larger than ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'the body could not be read')
  } finally {
    clearTimeout(timer)
  }
  if (timedOut) throw new HttpError(408, 'the body did not arrive in time')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export const parseJsonBytes = (bytes) => {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new HttpError(400, 'the body is not UTF-8 text')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'the body is not valid JSON')
  }
}

export const readJsonBody = async (request, options) =>
  parseJsonBytes(await readBodyBytes(request, options))
