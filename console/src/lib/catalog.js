const entriesOf = (catalog, app) => (catalog?.apps ?? []).filter(({ name }) => name === app)

export const appNamesOf = (catalog) =>
  [...new Set((catalog?.apps ?? []).map(({ name }) => name))].sort()

export const segmentsOf = (catalog, app) =>
  [...new Set(entriesOf(catalog, app).flatMap(({ segments }) => segments ?? []))].sort()

export const mapPagesOf = (catalog, app) =>
  [...new Set(entriesOf(catalog, app).flatMap(({ pages }) => pages ?? []))].sort()
