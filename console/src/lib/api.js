import { queryServers } from './client.js'
import { previousRange } from './days.js'

export const messageOf = (error) => error?.body?.error ?? error?.message ?? String(error)

export const runQuery = (api, scope, query) =>
  queryServers(api, scope.servers, { app: scope.app, from: scope.from, to: scope.to, ...query })

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

export const downloadText = (name, text, type) => downloadBlob(name, new Blob([text], { type }))

export const downloadBlob = (name, blob) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
