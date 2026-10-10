const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const HEX_GROUP = /^[0-9a-f]{1,4}$/i

const PART_BITS = { 4: 8, 6: 16 }

const parseIpv4 = (text) => {
  const match = IPV4.exec(text)
  if (!match) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
  return parts[0] > 255 || parts[1] > 255 || parts[2] > 255 || parts[3] > 255 ? null : parts
}

const pushGroups = (groups, part, last) => {
  if (!part) return true
  const items = part.split(':')
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (last && index === items.length - 1 && item.includes('.')) {
      const bytes = parseIpv4(item)
      if (!bytes) return false
      groups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3])
    } else if (HEX_GROUP.test(item)) {
      groups.push(parseInt(item, 16))
    } else {
      return false
    }
  }
  return true
}

const parseIpv6 = (text) => {
  const gap = text.indexOf('::')
  if (gap !== -1 && text.indexOf('::', gap + 1) !== -1) return null
  const left = []
  const right = []
  const head = gap === -1 ? text : text.slice(0, gap)
  if (!pushGroups(left, head, gap === -1)) return null
  if (gap !== -1 && !pushGroups(right, text.slice(gap + 2), true)) return null
  const missing = 8 - left.length - right.length
  if (gap === -1 ? missing !== 0 : missing < 1) return null
  for (let index = 0; index < missing; index++) left.push(0)
  for (const group of right) left.push(group)
  return left
}

const isMappedIpv4 = (groups) =>
  groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
  groups[4] === 0 && groups[5] === 0xffff

export const parseIp = (text) => {
  let plain = String(text).trim()
  if (plain.startsWith('[') && plain.endsWith(']')) plain = plain.slice(1, -1)
  const zone = plain.indexOf('%')
  if (zone !== -1) plain = plain.slice(0, zone)
  if (!plain.includes(':')) {
    const parts = parseIpv4(plain)
    return parts ? { version: 4, parts } : null
  }
  const groups = parseIpv6(plain)
  if (!groups) return null
  if (isMappedIpv4(groups)) {
    return {
      version: 4,
      parts: [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255],
    }
  }
  return { version: 6, parts: groups }
}

const BRACKETED_WITH_PORT = /^\[([^\]]+)\](?::\d{1,5})?$/

const IPV4_WITH_PORT = /^([\d.]+):\d{1,5}$/

export const parseClientAddress = (text) => {
  const plain = String(text ?? '').trim()
  const bracketed = BRACKETED_WITH_PORT.exec(plain)
  if (bracketed) return bracketed[1].includes(':') ? parseIp(bracketed[1]) : null
  const withPort = IPV4_WITH_PORT.exec(plain)
  return parseIp(withPort ? withPort[1] : plain)
}

export const formatIp = (ip) =>
  ip.version === 4 ? ip.parts.join('.') : ip.parts.map((part) => part.toString(16)).join(':')

export const parseNetwork = (text) => {
  const [address, length, ...rest] = String(text).trim().split('/')
  const ip = rest.length ? null : parseIp(address)
  if (!ip) throw new Error(`"${text}" is not an address or a network`)
  const max = ip.parts.length * PART_BITS[ip.version]
  const bits = length === undefined ? max : Number(length)
  if ((length !== undefined && !/^\d{1,3}$/.test(length)) || bits > max) {
    throw new Error(`"${text}" has a wrong prefix length`)
  }
  return { ...ip, bits }
}

export const inNetwork = (ip, network) => {
  if (!ip || ip.version !== network.version) return false
  const size = PART_BITS[ip.version]
  for (let bit = 0; bit < network.bits; bit += size) {
    const index = bit / size
    const shift = Math.max(0, size - (network.bits - bit))
    if ((ip.parts[index] >> shift) !== (network.parts[index] >> shift)) return false
  }
  return true
}
