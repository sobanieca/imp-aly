export const DEMO_APP = 'shop'

export const DEMO_MAP = ['/', '/products', '/products/:id', '/cart', '/checkout', '/account']

export const DEMO_SEGMENTS = ['plan']

const DAY_MS = 86_400_000

const PAGES = [
  ['/', 30],
  ['/products', 25],
  ['/products/:id', 25],
  ['/cart', 10],
  ['/checkout', 6],
  ['/account', 4],
]

const READY_BASE = {
  '/': 600,
  '/products': 900,
  '/products/:id': 1400,
  '/cart': 700,
  '/checkout': 1800,
  '/account': 1100,
}

const COUNTRIES = [
  ['PL', 30],
  ['DE', 20],
  ['US', 15],
  ['GB', 10],
  ['FR', 8],
  ['NL', 6],
  ['SE', 4],
  ['ES', 4],
  ['IT', 3],
]

const PLANS = [['free', 60], ['pro', 25], ['team', 10], [null, 5]]

const SEEN_ZONES = ['shop.hero', 'shop.list', 'shop.reviews', 'shop.footer']

const USED_ZONES = ['shop.hero', 'shop.list', 'shop.filters', null]

export const createRandom = (seed) => {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

const pick = (random, list) => list[Math.floor(random() * list.length)]

const weighted = (random, pairs) => {
  const total = pairs.reduce((sum, [, weight]) => sum + weight, 0)
  let value = random() * total
  for (const [item, weight] of pairs) {
    value -= weight
    if (value <= 0) return item
  }
  return pairs[0][0]
}

export const visitRecords = ({ random, visit, start, recent = false }) => {
  const plan = weighted(random, PLANS)
  const country = weighted(random, COUNTRIES)
  const records = []
  let at = start
  const views = 1 + Math.floor(random() * 5)
  for (let view = 0; view < views; view++) {
    const page = weighted(random, PAGES)
    const slow = recent && page === '/products/:id' ? 1.6 : 1
    const add = (fields) => {
      const record = { visit, at: at++, page, ...fields }
      if (plan) record.plan = plan
      records.push(record)
    }
    add({
      type: 'page',
      readyMs: Math.round(READY_BASE[page] * slow * (0.4 + random() * random() * 3)),
    })
    add({ type: 'seen', zone: pick(random, SEEN_ZONES) })
    if (random() < 0.7) add({ type: 'interaction', zone: pick(random, USED_ZONES) })
    if (page === '/checkout' && random() < 0.6) add({ type: 'outcome', name: 'shop.order-placed' })
    if (page === '/products/:id' && random() < 0.3) {
      add({ type: 'outcome', name: 'shop.added-to-cart' })
    }
    if (random() < (recent && page === '/cart' ? 0.12 : 0.02)) add({ type: 'error' })
    at += 5_000 + Math.floor(random() * 60_000)
  }
  return { country, records }
}

const dayOf = (time) => new Date(time).toISOString().slice(0, 10)

export const seedLines = ({ random, now, days }) => {
  const today = Date.parse(dayOf(now))
  const lines = []
  for (let back = days; back >= 0; back--) {
    const start = today - back * DAY_MS
    const weekday = new Date(start).getUTCDay()
    const base = (weekday === 0 || weekday === 6 ? 90 : 160) * (1 + (days - back) / 60)
    const share = back ? 1 : (now - start) / DAY_MS
    const visits = Math.round((base + random() * 40) * share)
    const latest = back ? start + DAY_MS - 3_600_000 : now - 3_600_000
    for (let index = 0; index < visits; index++) {
      const visitStart = start + Math.floor(random() * Math.max(0, latest - start))
      const { country, records } = visitRecords({
        random,
        visit: `d${back}v${index}`,
        start: visitStart,
        recent: back < 10,
      })
      for (const record of records) {
        lines.push(JSON.stringify([DEMO_APP, dayOf(record.at), { ...record, country }]))
      }
    }
  }
  return lines
}
