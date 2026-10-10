import { queryServers } from './client.js'
import { presetPrevious } from './ranges.js'

export const messageOf = (error) => error?.body?.error ?? error?.message ?? String(error)

export const runQuery = (api, scope, query) =>
  queryServers(api, scope.servers, { app: scope.app, from: scope.from, to: scope.to, ...query })

const previousScope = (scope) =>
  scope.preset ? { ...scope, ...presetPrevious(scope.preset, scope.today) } : null

export const runPrevious = (api, scope, query) => {
  const earlier = previousScope(scope)
  return earlier ? runQuery(api, earlier, query) : Promise.resolve(null)
}

export const runQueries = (api, scope, queries) =>
  Promise.all(queries.map((query) => runQuery(api, scope, query)))

export const problemsOf = (answers) => {
  const failed = new Map()
  const skipped = new Map()
  const warnings = new Set()
  for (const answer of answers.filter(Boolean)) {
    for (const entry of answer.failedServers ?? []) failed.set(entry.server, entry.reason)
    for (const entry of answer.skippedDays ?? []) {
      skipped.set(`${entry.server} ${entry.day} ${entry.source}`, entry)
    }
    for (const warning of answer.warnings ?? []) warnings.add(warning)
  }
  return {
    failed: [...failed].map(([server, reason]) => ({ server, reason })),
    skipped: [...skipped.values()],
    warnings: [...warnings],
  }
}
