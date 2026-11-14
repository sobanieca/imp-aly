import {
  BASE_COLUMNS,
  MAX_SEGMENTS,
  RESERVED_NAMES,
  SEGMENT_NAME_PATTERN,
} from '../shared/names.js'
import { appOnServers } from './client.js'

const appPath = (name) => `/apps/${encodeURIComponent(name)}`

export const registerApp = (api, servers, name, body) =>
  appOnServers(api, servers, 'PUT', appPath(name), body)

export const refreshApp = (api, row) =>
  appOnServers(api, row.servers, 'POST', `${appPath(row.name)}/refresh`)

export const removeApp = (api, row) => appOnServers(api, row.servers, 'DELETE', appPath(row.name))

export const removeQuestion = (row) =>
  row ? `Remove ${row.name} from ${row.servers.join(', ')}?` : 'Remove the app?'

const segmentNameProblem = (segment) => {
  const lower = segment.toLowerCase()
  if (BASE_COLUMNS.includes(lower)) return `"${segment}" is a built-in field - do not declare it.`
  if ([...RESERVED_NAMES].some((name) => name.toLowerCase() === lower)) {
    return `"${segment}" is a reserved name.`
  }
  if (!SEGMENT_NAME_PATTERN.test(segment)) {
    return `"${segment}" is not a name of 1 to 32 letters and digits that starts with a letter.`
  }
  return null
}

export const segmentProblem = (segments) => {
  const list = segments ?? []
  if (list.length > MAX_SEGMENTS) return `An app has at most ${MAX_SEGMENTS} segments.`
  const seen = new Set()
  for (const segment of list) {
    const problem = segmentNameProblem(segment)
    if (problem) return problem
    if (seen.has(segment.toLowerCase())) return `"${segment}" is given twice.`
    seen.add(segment.toLowerCase())
  }
  return null
}

const COUNTRY_NOTE = 'The server can add the country to each record, so "country" is not a segment.'

export const segmentsNote = (known) =>
  known.length
    ? `Segments of the apps on the servers: ${known
        .map(({ segment, apps }) => `${segment} (${apps.join(', ')})`)
        .join(', ')}. ${COUNTRY_NOTE}`
    : `No app on the servers has a segment yet. ${COUNTRY_NOTE}`

export const registerBody = (values) => ({
  segments: values.segments ?? [],
  appUrl: values.appUrl,
})
