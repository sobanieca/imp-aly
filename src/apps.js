import { fetchAppMap, parseAppMap } from './app-map.js'
import { readJson, writeJsonAtomic } from './fs-utils.js'
import { isAppName, MAX_SEGMENTS, RESERVED_NAMES, SEGMENT_NAME_PATTERN } from './names.js'
import { join } from './paths.js'

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const REJECTION_KINDS_LIMIT = 50

const isHttpUrl = (value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export const validateSegments = (segments) => {
  if (segments === undefined) return []
  if (!Array.isArray(segments)) throw new AppError('segments is a list of names, like ["plan"]')
  if (segments.length > MAX_SEGMENTS) {
    throw new AppError(`an app has at most ${MAX_SEGMENTS} segments`)
  }
  const seen = new Set()
  for (const segment of segments) {
    if (typeof segment !== 'string' || !SEGMENT_NAME_PATTERN.test(segment)) {
      throw new AppError(
        `segment "${segment}" is not a name of 1 to 32 letters and digits that starts with a letter`,
      )
    }
    if ([...RESERVED_NAMES].some((name) => name.toLowerCase() === segment.toLowerCase())) {
      throw new AppError(`segment "${segment}" is a reserved name`)
    }
    if (seen.has(segment.toLowerCase())) {
      throw new AppError(`segment "${segment}" is given twice`)
    }
    seen.add(segment.toLowerCase())
  }
  return [...segments]
}

export const appConfig = async (app) => {
  if (!app) return null
  const text = JSON.stringify({ pages: [...app.pages].sort(), segments: [...app.segments].sort() })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const toStored = (app) => ({
  mapUrl: app.mapUrl,
  pages: [...app.pages],
  segments: app.segments,
  createdAt: app.createdAt,
  mapUpdatedAt: app.mapUpdatedAt,
  mapError: app.mapError,
})

const fromStored = (name, stored) => ({
  name,
  mapUrl: stored.mapUrl ?? null,
  pages: new Set(stored.pages ?? []),
  segments: stored.segments ?? [],
  createdAt: stored.createdAt ?? null,
  mapUpdatedAt: stored.mapUpdatedAt ?? null,
  mapError: stored.mapError ?? null,
  accepted: 0,
  rejected: 0,
  rejections: {},
})

export const openApps = async ({ dataDir, fetchMap = fetchAppMap, now = Date.now }) => {
  const path = join(dataDir, 'apps.json')
  const stored = await readJson(path, { apps: {} })
  const apps = new Map()
  for (const [name, value] of Object.entries(stored.apps ?? {})) {
    if (isAppName(name)) apps.set(name, fromStored(name, value))
  }

  let saving = Promise.resolve()

  const save = () => {
    const snapshot = {
      apps: Object.fromEntries([...apps].map(([name, app]) => [name, toStored(app)])),
    }
    saving = saving.catch(() => {}).then(() => writeJsonAtomic(path, snapshot))
    return saving
  }

  const describe = (app) => ({
    name: app.name,
    mapUrl: app.mapUrl,
    pages: [...app.pages].sort(),
    segments: app.segments,
    createdAt: app.createdAt,
    mapUpdatedAt: app.mapUpdatedAt,
    mapError: app.mapError,
    accepted: app.accepted,
    rejected: app.rejected,
    rejections: app.rejections,
  })

  const requireApp = (name) => {
    const app = apps.get(name)
    if (!app) throw new AppError(`no app "${name}" is registered`, 404)
    return app
  }

  return {
    get: (name) => apps.get(name),

    list: () => [...apps.values()].map(describe),

    describe: (name) => describe(requireApp(name)),

    put: async (name, body) => {
      if (!isAppName(name)) {
        throw new AppError(
          `"${name}" is not an app name - use 1 to 63 lowercase letters, digits and "-", like myapp`,
        )
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError(
          'the body is an object, like {"mapUrl": "https://myapp.example/app-map.txt"}',
        )
      }
      const unknown = Object.keys(body).filter((key) =>
        !['mapUrl', 'map', 'segments'].includes(key)
      )
      if (unknown.length) throw new AppError(`unknown fields: ${unknown.join(', ')}`)
      const hasUrl = body.mapUrl !== undefined
      const hasMap = body.map !== undefined
      if (hasUrl === hasMap) {
        throw new AppError('give the app map as mapUrl (a URL) or as map (the text), not both')
      }
      const segments = validateSegments(body.segments)
      let pages
      if (hasUrl) {
        if (typeof body.mapUrl !== 'string' || !isHttpUrl(body.mapUrl)) {
          throw new AppError('mapUrl is an http or https URL')
        }
        try {
          pages = await fetchMap(body.mapUrl)
        } catch (error) {
          throw new AppError(`the app map could not be read: ${error.message}`, 422)
        }
      } else {
        if (typeof body.map !== 'string') throw new AppError('map is the text of app-map.txt')
        try {
          pages = parseAppMap(body.map)
        } catch (error) {
          throw new AppError(error.message, 422)
        }
      }
      const previous = apps.get(name)
      const app = fromStored(name, {
        mapUrl: hasUrl ? body.mapUrl : null,
        pages,
        segments,
        createdAt: previous?.createdAt ?? new Date(now()).toISOString(),
        mapUpdatedAt: new Date(now()).toISOString(),
        mapError: null,
      })
      if (previous) {
        app.accepted = previous.accepted
        app.rejected = previous.rejected
        app.rejections = previous.rejections
      }
      apps.set(name, app)
      await save()
      return describe(app)
    },

    remove: async (name) => {
      requireApp(name)
      apps.delete(name)
      await save()
    },

    refresh: async (name) => {
      const app = requireApp(name)
      if (!app.mapUrl) throw new AppError(`app "${name}" has an uploaded map and no mapUrl`)
      try {
        const pages = await fetchMap(app.mapUrl)
        if (apps.get(name) !== app) return describe(app)
        app.pages = new Set(pages)
        app.mapUpdatedAt = new Date(now()).toISOString()
        app.mapError = null
      } catch (error) {
        if (apps.get(name) !== app) return describe(app)
        app.mapError = error.message
      }
      await save()
      return describe(app)
    },

    refreshAll: async () => {
      for (const app of [...apps.values()]) {
        if (!app.mapUrl) continue
        try {
          const pages = await fetchMap(app.mapUrl)
          if (apps.get(app.name) !== app) continue
          app.pages = new Set(pages)
          app.mapUpdatedAt = new Date(now()).toISOString()
          app.mapError = null
        } catch (error) {
          if (apps.get(app.name) !== app) continue
          app.mapError = error.message
        }
      }
      await save()
    },

    countAccepted: (app, count) => {
      app.accepted += count
    },

    countRejected: (app, problem) => {
      app.rejected += 1
      if (Object.hasOwn(app.rejections, problem)) {
        app.rejections[problem] += 1
      } else if (Object.keys(app.rejections).length < REJECTION_KINDS_LIMIT) {
        app.rejections[problem] = 1
      }
    },

    flush: () => saving,
  }
}
