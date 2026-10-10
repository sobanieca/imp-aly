const failures = new Map()

const listeners = new Set()

const announce = () => {
  for (const listener of listeners) listener()
}

const AUTH_STATUSES = [401, 403]

const isAborted = (error) => error?.code === 'aborted' || error?.name === 'AbortError'

export const isConnectionProblem = (error) => {
  if (isAborted(error)) return false
  const status = error?.status
  if (typeof status !== 'number') return true
  return AUTH_STATUSES.includes(status) || status >= 500
}

export const markAnswered = (name) => {
  if (failures.delete(name)) announce()
}

const markFailed = (name, reason) => {
  if (failures.get(name) === reason) return
  failures.set(name, reason)
  announce()
}

export const noteOutcome = (name, error) => {
  if (isAborted(error)) return
  if (isConnectionProblem(error)) markFailed(name, error?.message ?? String(error))
  else markAnswered(name)
}

export const keepServers = (names) => {
  let changed = false
  for (const name of failures.keys()) {
    if (!names.includes(name)) changed = failures.delete(name) || changed
  }
  if (changed) announce()
}

export const failuresOf = () => [...failures].map(([server, reason]) => ({ server, reason }))

export const onHealthChange = (listener, signal) => {
  listeners.add(listener)
  signal.addEventListener('abort', () => listeners.delete(listener))
}

export const resetHealth = () => {
  failures.clear()
  announce()
}
