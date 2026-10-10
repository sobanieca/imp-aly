export const CLIENT_SHARE = 32

export const NETWORK_SHARE = 4

export const createInFlight = (
  { max, perClient = Math.max(1, Math.floor(max / CLIENT_SHARE)) },
) => {
  let count = 0
  const byKey = new Map()
  const limitOf = (client) => (client.scale > 1 ? perClient * NETWORK_SHARE : perClient)

  const release = (clients) => {
    count--
    for (const { key } of clients) {
      const left = byKey.get(key) - 1
      if (left > 0) byKey.set(key, left)
      else byKey.delete(key)
    }
  }

  return {
    count: () => count,
    full: () => count >= max,
    enter: (clients) => {
      if (clients.some((client) => (byKey.get(client.key) ?? 0) >= limitOf(client))) return null
      count++
      for (const { key } of clients) byKey.set(key, (byKey.get(key) ?? 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        release(clients)
      }
    },
  }
}
