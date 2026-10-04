import { previousRange } from './days.js'

export const messageOf = (error) => error?.body?.error ?? error?.message ?? String(error)

export const serversParam = (servers) => (servers?.length ? servers.join(',') : undefined)

export const runQuery = (api, scope, query) =>
  api.post('/query', {
    query: { servers: serversParam(scope.servers) },
    body: { app: scope.app, from: scope.from, to: scope.to, ...query },
  })

export const previousScope = (scope) => ({ ...scope, ...previousRange(scope.from, scope.to) })

export const runQueries = (api, scope, queries) =>
  Promise.all(queries.map((query) => runQuery(api, scope, query)))

export const problemsOf = (answers) => {
  const failed = new Map()
  const skipped = new Map()
  const warnings = new Set()
  for (const answer of answers) {
    for (const entry of answer.failedServers ?? []) failed.set(entry.server, entry.reason)
    for (const entry of answer.skippedDays ?? []) {
      skipped.set(`${entry.server} ${entry.day}`, entry)
    }
    for (const warning of answer.warnings ?? []) warnings.add(warning)
  }
  return {
    failed: [...failed].map(([server, reason]) => ({ server, reason })),
    skipped: [...skipped.values()],
    warnings: [...warnings],
  }
}

export const downloadText = (name, text, type) => {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
