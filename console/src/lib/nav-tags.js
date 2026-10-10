import { serversOfApp } from './catalog.js'

const TAG_NAME_LENGTH = 10

const MORE = '...'

export const shortName = (name, max = TAG_NAME_LENGTH) =>
  name.length <= max ? name : `${name.slice(0, max - MORE.length)}${MORE}`

const savedNames = (catalog) => (catalog?.servers?.servers ?? []).map(({ name }) => name)

const withTitle = (tag, names) => {
  const title = names.join(', ')
  return title === tag.text ? tag : { ...tag, title }
}

export const serversTag = ({ catalog, app, failures = [] }) => {
  const saved = savedNames(catalog)
  if (!saved.length) return null
  const failed = failures.filter(({ server }) => saved.includes(server))
  if (failed.length) {
    return withTitle(
      { text: `${failed.length} failed`, color: 'red' },
      failed.map(({ server }) => server),
    )
  }
  const used = serversOfApp(catalog, app)
  const names = used.length ? used : saved
  const [first, ...rest] = names
  return withTitle(
    { text: rest.length ? `${shortName(first)} +${rest.length}` : shortName(first) },
    names,
  )
}
