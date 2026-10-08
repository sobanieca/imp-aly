import { sealDay } from '../src/column-store.js'
import { finalizeQuery } from '../src/query-core.js'
import { runQuery } from '../src/query.js'
import { applySegment } from '../src/storage.js'
import { temporaryDir } from './assert.js'

export const DAYS = ['2026-09-20', '2026-09-21']

export const SOURCE = '0123456789abcdef'

export const OTHER_SOURCE = 'fedcba9876543210'

export const dayPath = (dataDir, day, source = SOURCE, app = 'myapp') =>
  `${dataDir}/apps/${app}/${day}/${source}`

export const sealAll = async (dataDir, source = SOURCE, days = DAYS) => {
  for (const day of days) await sealDay(dayPath(dataDir, day, source))
}

const PAGES = ['/', '/invoices', '/invoices/:id']

export const fill = async ({ keep = () => true, source = SOURCE, days = DAYS } = {}) => {
  const dataDir = await temporaryDir()
  let text = ''
  let seed = 7
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (const day of days) {
    for (let visit = 0; visit < 40; visit++) {
      const visitId = `v${visit % 30}`
      const kept = keep(visitId)
      const plan = visit % 3 === 0 ? null : ['pro', 'free'][visit % 2]
      for (let step = 0; step < 12; step++) {
        const type = ['page', 'seen', 'used', 'used', 'outcome', 'error'][next(6)]
        const record = {
          type,
          visit: visitId,
          at: Date.parse(day) + visit * 1000 + step,
          page: PAGES[next(3)],
          country: visit % 4 ? 'PL' : 'DE',
        }
        if (plan) record.plan = plan
        if (type === 'seen' || (type === 'used' && next(2))) {
          record.zone = `myapp.zone-${next(4)}`
        }
        if (type === 'outcome') record.name = `myapp.done-${next(2)}`
        if (kept) text += `${JSON.stringify(['myapp', day, record])}\n`
      }
    }
  }
  await applySegment({ dataDir, source, segment: 1, text })
  return dataDir
}

export const saveStream = async (stream, path) => {
  const file = await Deno.open(path, { write: true, create: true, truncate: true })
  await stream.pipeTo(file.writable)
}

export const openFile = (path) => async () => (await Deno.open(path)).readable

export const ask = async (dataDir, query) =>
  finalizeQuery(query, [{ server: 'local', answer: await runQuery({ dataDir, query }) }])
