const SHOP = {
  name: 'shop',
  segments: ['plan'],
  volume: 1,
  map: [
    '/',
    '/products',
    '/products/:id',
    '/products/:id/reviews',
    '/search',
    '/cart',
    '/checkout',
    '/orders',
    '/orders/:id',
    '/account',
    '/account/addresses',
    '/help',
    '/wishlist',
    '/returns',
    '/gift-cards',
    '/compare',
    '/stores/:id',
  ],
  pages: [
    ['/', 28],
    ['/products', 22],
    ['/products/:id', 22],
    ['/products/:id/reviews', 3],
    ['/search', 10],
    ['/cart', 7],
    ['/checkout', 5],
    ['/orders', 3],
    ['/orders/:id', 1.5],
    ['/account', 2],
    ['/account/addresses', 0.4],
    ['/help', 0.6],
    ['/wishlist', 0.3],
    ['/returns', 0.15],
    ['/gift-cards', 0.05],
  ],
  zones: {
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
  },
  outcomes: {
    '/products': [['shop.filter-applied', 0.35]],
    '/products/:id': [['shop.added-to-cart', 0.3]],
    '/search': [['shop.search-run', 0.7]],
    '/cart': [['shop.coupon-applied', 0.08], ['shop.coupon-rejected', 0.05]],
    '/checkout': [['shop.order-placed', 0.6], ['shop.payment-failed', 0.03]],
    '/account': [['shop.address-saved', 0.1]],
  },
  segmentValues: { plan: [['free', 60], ['pro', 25], ['team', 10], [null, 5]] },
  failing: { page: '/cart', outcome: 'shop.payment-failed' },
}

const CRM = {
  name: 'crm',
  segments: ['role'],
  volume: 0.45,
  map: [
    '/',
    '/users',
    '/users/:id',
    '/users/:id/details',
    '/users/:id/orders',
    '/users/invites',
    '/companies',
    '/companies/:id',
    '/reports',
    '/reports/:id',
    '/settings',
    '/settings/billing',
    '/settings/team',
    '/audit-log',
  ],
  pages: [
    ['/', 18],
    ['/users', 20],
    ['/users/:id', 12],
    ['/users/:id/details', 9],
    ['/users/:id/orders', 6],
    ['/users/invites', 3],
    ['/companies', 8],
    ['/companies/:id', 6],
    ['/reports', 5],
    ['/reports/:id', 4],
    ['/settings', 2],
    ['/settings/billing', 0.6],
    ['/settings/team', 1],
  ],
  zones: {
    '/': [['crm.activity-feed', 1, 0.35], ['crm.quick-actions', 0.9, 0.2]],
    '/users': [['crm.user-table', 1, 0.8], ['crm.user-filters', 0.8, 0.3]],
    '/users/:id/details': [['crm.profile-form', 1, 0.5], ['crm.notes', 0.6, 0.02]],
    '/users/invites': [['crm.invite-form', 1, 0.7]],
    '/companies': [['crm.company-table', 1, 0.7]],
    '/reports/:id': [['crm.report-chart', 1, 0.25], ['crm.export-button', 0.9, 0.08]],
    '/settings/billing': [['crm.billing-form', 1, 0.3]],
  },
  outcomes: {
    '/users/invites': [['crm.invite-sent', 0.6]],
    '/users/:id/details': [['crm.user-updated', 0.3]],
    '/reports/:id': [['crm.report-exported', 0.08]],
    '/companies/:id': [['crm.deal-created', 0.15]],
    '/settings/billing': [['crm.plan-changed', 0.1]],
  },
  segmentValues: { role: [['admin', 15], ['sales', 55], ['support', 30]] },
  failing: { page: '/reports/:id', outcome: 'crm.report-exported' },
}

const DOCS = {
  name: 'docs',
  segments: [],
  volume: 0.7,
  map: ['/', '/guides', '/guides/:slug', '/api', '/api/:name', '/changelog', '/search'],
  pages: [
    ['/', 25],
    ['/guides', 12],
    ['/guides/:slug', 30],
    ['/api', 8],
    ['/api/:name', 18],
    ['/changelog', 4],
    ['/search', 6],
  ],
  zones: {
    '/guides/:slug': [['docs.toc', 0.9, 0.2], ['docs.feedback', 0.4, 0.05]],
    '/api/:name': [['docs.code-copy', 0.95, 0.3]],
    '/search': [['docs.search-box', 1, 0.95]],
  },
  outcomes: {
    '/guides/:slug': [['docs.feedback-sent', 0.04]],
    '/api/:name': [['docs.code-copied', 0.3]],
    '/search': [['docs.search-run', 0.8]],
  },
  segmentValues: {},
  failing: { page: '/search', outcome: 'docs.search-run' },
}

const namesOf = (lists) => [...new Set(Object.values(lists).flat().map(([name]) => name))].sort()

const buildOf = (app) => ({
  pages: app.map,
  zones: namesOf(app.zones),
  outcomes: namesOf(app.outcomes),
})

export const DEMO_APPS = [SHOP, CRM, DOCS].map((app) => ({
  ...app,
  build: buildOf(app),
}))

const DAY_MS = 86_400_000

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

export const visitRecords = ({ app, random, visit, start, recent = false }) => {
  const values = Object.fromEntries(
    app.segments.map((segment) => [segment, weighted(random, app.segmentValues[segment])]),
  )
  const country = weighted(random, COUNTRIES)
  const records = []
  let at = start
  const views = 1 + Math.floor(random() * 5)
  for (let view = 0; view < views; view++) {
    const page = weighted(random, app.pages)
    const add = (fields) => {
      const record = { visit, at: at++, page, ...fields }
      for (const [segment, value] of Object.entries(values)) {
        if (value) record[segment] = value
      }
      records.push(record)
    }
    add({ type: 'page' })
    let used = false
    for (const [zone, seenShare, usedShare] of app.zones[page] ?? []) {
      if (random() >= seenShare) continue
      add({ type: 'seen', zone })
      if (random() >= usedShare) continue
      add({ type: 'used', zone })
      used = true
    }
    if (used || random() < 0.4) add({ type: 'used', zone: null })
    for (const [name, share] of app.outcomes[page] ?? []) {
      const boost = recent && name === app.failing.outcome ? 3 : 1
      if (random() < share * boost) add({ type: 'outcome', name })
    }
    if (random() < (recent && page === app.failing.page ? 0.12 : 0.02)) add({ type: 'error' })
    at += 5_000 + Math.floor(random() * 60_000)
  }
  return { country, records }
}

const dayOf = (time) => new Date(time).toISOString().slice(0, 10)

export const seedLines = ({ random, now, days }) => {
  const today = Date.parse(dayOf(now))
  const lines = []
  for (const app of DEMO_APPS) {
    for (let back = days; back >= 0; back--) {
      const start = today - back * DAY_MS
      const weekday = new Date(start).getUTCDay()
      const base = (weekday === 0 || weekday === 6 ? 90 : 160) * (1 + (days - back) / 60)
      const share = back ? 1 : (now - start) / DAY_MS
      const visits = Math.round((base + random() * 40) * share * app.volume)
      const latest = back ? start + DAY_MS - 3_600_000 : now - 3_600_000
      for (let index = 0; index < visits; index++) {
        const visitStart = start + Math.floor(random() * Math.max(0, latest - start))
        const { country, records } = visitRecords({
          app,
          random,
          visit: `${app.name}d${back}v${index}`,
          start: visitStart,
          recent: back < 10,
        })
        for (const record of records) {
          lines.push(JSON.stringify([app.name, dayOf(record.at), { ...record, country }]))
        }
      }
    }
  }
  return lines
}
