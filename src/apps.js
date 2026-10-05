import { BUILD_FILE, fetchBuild, fetchText, folderUrl, parseBuild } from './app-build.js'
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

const sorted = (values) => [...values].sort()

export const appConfig = async (app) => {
  if (!app) return null
  const text = JSON.stringify({
    pages: sorted(app.pages),
    zones: sorted(app.zones),
    outcomes: sorted(app.outcomes),
    segments: sorted(app.segments),
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const toStored = (app) => ({
  appUrl: app.appUrl,
  pages: sorted(app.pages),
  zones: sorted(app.zones),
  outcomes: sorted(app.outcomes),
  segments: app.segments,
  createdAt: app.createdAt,
  buildUpdatedAt: app.buildUpdatedAt,
  buildError: app.buildError,
})

const fromStored = (name, stored) => ({
  name,
  appUrl: stored.appUrl ?? null,
  pages: new Set(stored.pages ?? []),
  zones: new Set(stored.zones ?? []),
  outcomes: new Set(stored.outcomes ?? []),
  segments: stored.segments ?? [],
  createdAt: stored.createdAt ?? null,
  buildUpdatedAt: stored.buildUpdatedAt ?? null,
  buildError: stored.buildError ?? null,
  accepted: 0,
  rejected: 0,
  rejections: {},
})

const UPLOAD_HINT = `an upload gives build: the text of ${BUILD_FILE}`

const readSource = async (body, fetchFile) => {
  const hasUrl = body.appUrl !== undefined
  const uploaded = body.build !== undefined
  if (hasUrl && uploaded) {
    throw new AppError('give appUrl (a URL) or the uploaded build, not both')
  }
  if (hasUrl) {
    const appUrl = typeof body.appUrl === 'string' ? folderUrl(body.appUrl) : null
    if (!appUrl) {
      throw new AppError(
        'appUrl is the http or https URL of the folder of the build, like https://myapp.example/',
      )
    }
    try {
      return { appUrl, ...(await fetchBuild(appUrl, fetchFile)) }
    } catch (error) {
      throw new AppError(`the build could not be read: ${error.message}`, 422)
    }
  }
  if (!uploaded) throw new AppError(`give appUrl, or ${UPLOAD_HINT}`)
  if (typeof body.build !== 'string') throw new AppError(UPLOAD_HINT)
  try {
    return { appUrl: null, ...parseBuild(body.build) }
  } catch (error) {
    throw new AppError(error.message, 422)
  }
}

export const openApps = async ({ dataDir, fetchFile = fetchText, now = Date.now }) => {
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
    appUrl: app.appUrl,
    pages: sorted(app.pages),
    zones: sorted(app.zones),
    outcomes: sorted(app.outcomes),
    segments: app.segments,
    createdAt: app.createdAt,
    buildUpdatedAt: app.buildUpdatedAt,
    buildError: app.buildError,
    accepted: app.accepted,
    rejected: app.rejected,
    rejections: app.rejections,
  })

  const requireApp = (name) => {
    const app = apps.get(name)
    if (!app) throw new AppError(`no app "${name}" is registered`, 404)
    return app
  }

  const reread = async (app) => {
    try {
      const build = await fetchBuild(app.appUrl, fetchFile)
      if (apps.get(app.name) !== app) return false
      app.pages = new Set(build.pages)
      app.zones = new Set(build.zones)
      app.outcomes = new Set(build.outcomes)
      app.buildUpdatedAt = new Date(now()).toISOString()
      app.buildError = null
    } catch (error) {
      if (apps.get(app.name) !== app) return false
      app.buildError = error.message
    }
    return true
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
        throw new AppError('the body is an object, like {"appUrl": "https://myapp.example/"}')
      }
      const unknown = Object.keys(body).filter((key) =>
        !['appUrl', 'build', 'segments'].includes(key)
      )
      if (unknown.length) throw new AppError(`unknown fields: ${unknown.join(', ')}`)
      const segments = validateSegments(body.segments)
      const source = await readSource(body, fetchFile)
      const previous = apps.get(name)
      const app = fromStored(name, {
        ...source,
        segments,
        createdAt: previous?.createdAt ?? new Date(now()).toISOString(),
        buildUpdatedAt: new Date(now()).toISOString(),
        buildError: null,
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
      if (!app.appUrl) throw new AppError(`app "${name}" has an uploaded build and no appUrl`)
      if (await reread(app)) await save()
      return describe(app)
    },

    refreshAll: async () => {
      for (const app of [...apps.values()]) {
        if (app.appUrl) await reread(app)
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
