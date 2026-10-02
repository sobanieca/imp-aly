export const parseOrigin = (text) => {
  const value = String(text).trim()
  let url
  try {
    url = new URL(value)
  } catch {
    url = null
  }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
    throw new Error(`"${value}" is not an origin like https://myapp.example`)
  }
  return value
}

export const parseOrigins = (list) => list.map(parseOrigin)

export const createOriginCheck = (allowed) => {
  if (!allowed?.length) {
    return () => ({ allowed: true, headers: { 'access-control-allow-origin': '*' } })
  }
  const origins = new Set(parseOrigins(allowed))
  return (origin) => {
    if (origin === null) return { allowed: true, headers: { vary: 'origin' } }
    if (!origins.has(origin)) return { allowed: false, headers: { vary: 'origin' } }
    return { allowed: true, headers: { 'access-control-allow-origin': origin, vary: 'origin' } }
  }
}
