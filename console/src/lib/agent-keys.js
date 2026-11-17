const MINUTE_MS = 60_000

export const DURATIONS = [
  { value: '1', label: '1 hour' },
  { value: '4', label: '4 hours' },
  { value: '8', label: '8 hours' },
  { value: '24', label: '24 hours' },
]

export const agentKeyBody = ({ name, hours }) => ({ name, hours: Number(hours) })

export const agentCommand = ({ name, url, key }) => `imp-aly add ${name} ${url} -a ${key}`

export const timeLeft = (expiresAt, now = Date.now()) => {
  const minutes = Math.ceil((new Date(expiresAt).getTime() - now) / MINUTE_MS)
  if (!(minutes > 0)) return 'expired'
  if (minutes < 60) return `${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min left` : `${hours} h left`
}
