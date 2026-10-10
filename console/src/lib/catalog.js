const entriesOf = (catalog, app) => (catalog?.apps ?? []).filter(({ name }) => name === app)

const unique = (values) => [...new Set(values)].sort()

export const appNamesOf = (catalog) => unique((catalog?.apps ?? []).map(({ name }) => name))

export const serversOfApp = (catalog, app) => [
  ...new Set(entriesOf(catalog, app).map(({ server }) => server)),
]

export const segmentsOf = (catalog, app) =>
  unique(entriesOf(catalog, app).flatMap(({ segments }) => segments ?? []))

export const knownSegments = (catalog) => {
  const apps = new Map()
  for (const entry of catalog?.apps ?? []) {
    for (const segment of entry.segments ?? []) {
      apps.set(segment, [...(apps.get(segment) ?? []), entry.name])
    }
  }
  return [...apps.keys()].sort().map((segment) => ({ segment, apps: unique(apps.get(segment)) }))
}

export const mapPagesOf = (catalog, app) =>
  unique(entriesOf(catalog, app).flatMap(({ pages }) => pages ?? []))

const sum = (entries, field) => entries.reduce((total, entry) => total + (entry[field] ?? 0), 0)

export const registryRows = (catalog) =>
  appNamesOf(catalog).map((name) => {
    const entries = entriesOf(catalog, name)
    return {
      id: name,
      name,
      entries,
      servers: entries.map(({ server }) => server),
      pages: unique(entries.flatMap(({ pages }) => pages ?? [])),
      zones: unique(entries.flatMap(({ zones }) => zones ?? [])),
      outcomes: unique(entries.flatMap(({ outcomes }) => outcomes ?? [])),
      segments: unique(entries.flatMap(({ segments }) => segments ?? [])),
      accepted: sum(entries, 'accepted'),
      rejected: sum(entries, 'rejected'),
      buildErrors: entries.filter(({ buildError }) => buildError).length,
      fromUrl: entries.filter(({ appUrl }) => appUrl).map(({ server }) => server),
    }
  })
