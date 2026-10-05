export const DEMO_APP = 'shop'

export const DEMO_MAP = [
  '/',
  '/products',
  '/products/:id',
  '/search',
  '/cart',
  '/checkout',
  '/orders',
  '/account',
  '/help',
  '/wishlist',
  '/returns',
  '/gift-cards',
  '/compare',
  '/stores/:id',
]

export const DEMO_SEGMENTS = ['plan']

const DAY_MS = 86_400_000

const PAGES = [
  ['/', 28],
  ['/products', 22],
  ['/products/:id', 22],
  ['/search', 10],
  ['/cart', 7],
  ['/checkout', 5],
  ['/orders', 3],
  ['/account', 2],
  ['/help', 0.6],
  ['/wishlist', 0.3],
  ['/returns', 0.15],
  ['/gift-cards', 0.05],
]

const ZONES = {
  '/': [['shop.hero', 0.95, 0.3], ['shop.newsletter', 0.4, 0.03]],
  '/products': [
    ['shop.product-list', 1, 0.8],
    ['shop.filters', 0.9, 0.4],
    ['shop.compare-button', 0.7, 0.005],
  ],
  '/products/:id': [
    ['shop.gallery', 1, 0.4],
    ['shop.add-to-cart', 0.95, 0.5],
    ['shop.size-picker', 0.85, 0.45],
    ['shop.reviews', 0.5, 0.15],
    ['shop.share', 0.6, 0.01],
  ],
  '/search': [['shop.search-box', 1, 0.9]],
  '/cart': [['shop.cart-items', 1, 0.6], ['shop.promo-code', 0.8, 0.12]],
  '/checkout': [
    ['shop.shipping-form', 1, 0.85],
    ['shop.payment-form', 0.8, 0.9],
    ['shop.gift-message', 0.3, 0],
  ],
  '/orders': [['shop.order-list', 1, 0.3]],
  '/account': [['shop.profile-form', 1, 0.4]],
}

const OUTCOMES = {
  '/products': [['shop.filter-applied', 0.35]],
  '/products/:id': [['shop.added-to-cart', 0.3]],
  '/search': [['shop.search-run', 0.7]],
  '/cart': [['shop.coupon-applied', 0.08], ['shop.coupon-rejected', 0.05]],
  '/checkout': [['shop.order-placed', 0.6], ['shop.payment-failed', 0.03]],
  '/account': [['shop.address-saved', 0.1]],
}

const namesOf = (lists) => [...new Set(Object.values(lists).flat().map(([name]) => name))].sort()

export const DEMO_ZONES = namesOf(ZONES)

export const DEMO_OUTCOMES = namesOf(OUTCOMES)

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

export const createRandom = (seed) => {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

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
    const add = (fields) => {
      const record = { visit, at: at++, page, ...fields }
      if (plan) record.plan = plan
      records.push(record)
    }
    add({ type: 'page' })
    let used = false
    for (const [zone, seenShare, usedShare] of ZONES[page] ?? []) {
      if (random() >= seenShare) continue
      add({ type: 'seen', zone })
      if (random() >= usedShare) continue
      add({ type: 'used', zone })
      used = true
    }
    if (used || random() < 0.4) add({ type: 'used', zone: null })
    for (const [name, share] of OUTCOMES[page] ?? []) {
      const boost = recent && name === 'shop.payment-failed' ? 3 : 1
      if (random() < share * boost) add({ type: 'outcome', name })
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
