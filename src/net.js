const isLinkLocal = (address) => address.startsWith('fe80:') || address.startsWith('169.254.')

const isLoopback = (address) => address === '::1' || address.startsWith('127.')

const isPrivateV4 = (address) =>
  address.startsWith('10.') || address.startsWith('192.168.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(address)

export const getLocalAddresses = () => {
  const all = Deno.networkInterfaces()
    .map((network) => network.address)
    .filter((address) => !isLoopback(address) && !isLinkLocal(address))
  const score = (address) => (address.includes(':') ? 2 : isPrivateV4(address) ? 1 : 0)
  return [...new Set(all)].sort((a, b) => score(a) - score(b))
}

export const formatHost = (address) => (address.includes(':') ? `[${address}]` : address)
