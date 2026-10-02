const ROUND_CONSTANTS = new Int32Array([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
])

const INITIAL_STATE = [
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
]

const BLOCK_BYTES = 64

const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits))

export const createSha256 = () => {
  const state = new Int32Array(INITIAL_STATE)
  const words = new Int32Array(64)
  const pending = new Uint8Array(BLOCK_BYTES)
  let pendingBytes = 0
  let totalBytes = 0
  let finished = false

  const compress = (bytes, offset) => {
    for (let index = 0; index < 16; index++) {
      const at = offset + index * 4
      words[index] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) |
        bytes[at + 3]
    }
    for (let index = 16; index < 64; index++) {
      const early = words[index - 15]
      const late = words[index - 2]
      const small0 = rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3)
      const small1 = rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10)
      words[index] = (words[index - 16] + small0 + words[index - 7] + small1) | 0
    }
    let a = state[0]
    let b = state[1]
    let c = state[2]
    let d = state[3]
    let e = state[4]
    let f = state[5]
    let g = state[6]
    let h = state[7]
    for (let index = 0; index < 64; index++) {
      const big1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const choice = (e & f) ^ (~e & g)
      const first = (h + big1 + choice + ROUND_CONSTANTS[index] + words[index]) | 0
      const big0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const second = (big0 + majority) | 0
      h = g
      g = f
      f = e
      e = (d + first) | 0
      d = c
      c = b
      b = a
      a = (first + second) | 0
    }
    state[0] = (state[0] + a) | 0
    state[1] = (state[1] + b) | 0
    state[2] = (state[2] + c) | 0
    state[3] = (state[3] + d) | 0
    state[4] = (state[4] + e) | 0
    state[5] = (state[5] + f) | 0
    state[6] = (state[6] + g) | 0
    state[7] = (state[7] + h) | 0
  }

  const update = (bytes) => {
    if (finished) throw new Error('the hash is already finished')
    totalBytes += bytes.length
    let offset = 0
    if (pendingBytes > 0) {
      const take = Math.min(BLOCK_BYTES - pendingBytes, bytes.length)
      pending.set(bytes.subarray(0, take), pendingBytes)
      pendingBytes += take
      offset = take
      if (pendingBytes < BLOCK_BYTES) return
      compress(pending, 0)
      pendingBytes = 0
    }
    while (offset + BLOCK_BYTES <= bytes.length) {
      compress(bytes, offset)
      offset += BLOCK_BYTES
    }
    pending.set(bytes.subarray(offset), 0)
    pendingBytes = bytes.length - offset
  }

  const digest = () => {
    if (finished) throw new Error('the hash is already finished')
    const bits = totalBytes * 8
    const tail = new Uint8Array(pendingBytes < 56 ? BLOCK_BYTES : BLOCK_BYTES * 2)
    tail.set(pending.subarray(0, pendingBytes))
    tail[pendingBytes] = 0x80
    const view = new DataView(tail.buffer)
    view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32))
    view.setUint32(tail.length - 4, bits >>> 0)
    for (let offset = 0; offset < tail.length; offset += BLOCK_BYTES) compress(tail, offset)
    finished = true
    return [...state].map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('')
  }

  return { update, digest }
}

export const sha256Hex = (bytes) => {
  const hash = createSha256()
  hash.update(bytes)
  return hash.digest()
}

export const hashStream = async (stream) => {
  const hash = createSha256()
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest()
}
