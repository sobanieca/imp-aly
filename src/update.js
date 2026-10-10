import { readJson, removeIfExists, syncDirectory, writeAll, writeJsonAtomic } from './fs-utils.js'
import { dirname, getHome, join } from './paths.js'
import { createSha256 } from './sha256.js'

export const MANIFEST_URL = 'https://sobanieca.github.io/imp-aly/versions.json'

export const DOWNLOAD_URL = 'https://github.com/sobanieca/imp-aly/releases/download'

export const RELEASES_URL = 'https://github.com/sobanieca/imp-aly/releases'

export const RELEASES_API_URL =
  'https://api.github.com/repos/sobanieca/imp-aly/releases?per_page=100'

export const MIN_RELEASE_AGE_DAYS = 7

const DAY_MS = 86_400_000

export const UPDATE_STATE_DIR = '/var/lib/imp-aly-update'

const MANIFEST_TIMEOUT_MS = 30_000

const DOWNLOAD_TIMEOUT_MS = 600_000

const VERSION_TIMEOUT_MS = 10_000

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const SHA256_HEX = /^[0-9a-f]{64}$/

export const parseVersion = (text) => {
  const match = VERSION.exec(text)
  return match ? match.slice(1).map(Number) : null
}

export const compareVersions = (a, b) => {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

export const isAutoCompatible = (current, candidate) => {
  const [major, minor] = parseVersion(current)
  const [candidateMajor, candidateMinor] = parseVersion(candidate)
  if (major === 0) return candidateMajor === 0 && candidateMinor === minor
  return candidateMajor === major
}

export const parseManifest = (value) => {
  if (!Array.isArray(value?.versions)) {
    throw new Error('the version list has no "versions" array')
  }
  return value.versions.filter((entry) =>
    typeof entry?.version === 'string' && parseVersion(entry.version) &&
    Number.isInteger(entry.format)
  )
}

export const parseReleases = (value) => {
  if (!Array.isArray(value)) throw new Error('the GitHub API sent no list of releases')
  const published = new Map()
  for (const release of value) {
    const tag = release?.tag_name
    const at = Date.parse(release?.published_at ?? '')
    if (typeof tag !== 'string' || !tag.startsWith('v') || !parseVersion(tag.slice(1))) continue
    if (release.draft || release.prerelease || !Number.isFinite(at)) continue
    published.set(tag.slice(1), at)
  }
  return published
}

export const withPublishDates = (versions, published) =>
  versions.map((entry) => ({ ...entry, published: published.get(entry.version) ?? null }))

const releaseAgeReady = (published, now) =>
  published !== null && published !== undefined && now - published > MIN_RELEASE_AGE_DAYS * DAY_MS

const holdReason = ({ current, format, entry, skipped = [], auto = false, now }) => {
  if (entry.format !== format) return 'format'
  if (auto && !isAutoCompatible(current, entry.version)) return 'major'
  if (auto && !releaseAgeReady(entry.published, now)) return 'age'
  if (skipped.includes(entry.version)) return 'skipped'
  return null
}

export const pickUpdate = (
  { current, format, versions, skipped = [], auto = false, now = Date.now() },
) => {
  const newer = versions
    .filter((entry) => compareVersions(entry.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
  const held = []
  for (const entry of newer) {
    const reason = holdReason({ current, format, entry, skipped, auto, now })
    if (!reason) return { target: entry.version, held }
    held.push({ version: entry.version, reason, published: entry.published ?? null })
  }
  return { target: null, held }
}

export const assetName = (os = Deno.build.os, arch = Deno.build.arch) => {
  const osName = { linux: 'linux', darwin: 'macos' }[os]
  const archName = { x86_64: 'x64', aarch64: 'arm64' }[arch]
  if (!osName || !archName) throw new Error(`imp-aly has no release for ${os} on ${arch}`)
  return `imp-aly-${osName}-${archName}`
}

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1)

export const stagedPath = (binary) => join(dirname(binary), `.${baseName(binary)}.new`)

export const previousPath = (binary) => join(dirname(binary), `.${baseName(binary)}.previous`)

export const stateDir = () => {
  if (Deno.uid() === 0) return UPDATE_STATE_DIR
  const base = Deno.env.get('XDG_STATE_HOME') || join(getHome(), '.local', 'state')
  return join(base, 'imp-aly')
}

const get = async (fetcher, url, timeoutMs, headers = {}) => {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${url} answered ${response.status}`)
  }
  return response
}

export const fetchVersions = async ({ fetcher = fetch, manifestUrl = MANIFEST_URL } = {}) => {
  const response = await get(fetcher, manifestUrl, MANIFEST_TIMEOUT_MS)
  return parseManifest(await response.json())
}

export const fetchPublishDates = async (
  { fetcher = fetch, releasesUrl = RELEASES_API_URL } = {},
) => {
  const response = await get(fetcher, releasesUrl, MANIFEST_TIMEOUT_MS, {
    accept: 'application/vnd.github+json',
  })
  return parseReleases(await response.json())
}

export const readSkipped = async (dir) =>
  (await readJson(join(dir, 'skipped.json'), {})).versions ??
    []

export const addSkipped = async (dir, version) => {
  await Deno.mkdir(dir, { recursive: true })
  const versions = await readSkipped(dir)
  if (versions.includes(version)) return
  await writeJsonAtomic(join(dir, 'skipped.json'), { versions: [...versions, version] })
}

export const lockUpdates = async (dir) => {
  await Deno.mkdir(dir, { recursive: true })
  const file = await Deno.open(join(dir, 'lock'), { write: true, create: true })
  if (!(await file.tryLock(true))) {
    file.close()
    throw new Error('another imp-aly update runs now')
  }
  return file
}

export const checkInstalled = async (binary, running) => {
  const installed = await reportedVersion(binary)
  if (installed !== running) {
    throw new Error(
      `${binary} is imp-aly ${
        installed ?? 'of an unknown version'
      } now, not ${running} - another update replaced it, run imp-aly update again`,
    )
  }
}

export const reportedVersion = async (binary) => {
  try {
    const { code, stdout } = await new Deno.Command(binary, {
      args: ['--version'],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    }).output()
    return code === 0 ? new TextDecoder().decode(stdout).trim() : null
  } catch {
    return null
  }
}

const openStaged = async (path) => {
  await removeIfExists(path)
  try {
    return await Deno.open(path, { write: true, createNew: true, mode: 0o755 })
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new Error(`cannot write ${dirname(path)} - run: sudo imp-aly update`)
    }
    throw error
  }
}

export const stageBinary = async ({
  binary,
  version,
  fetcher = fetch,
  downloadUrl = DOWNLOAD_URL,
  asset = assetName(),
}) => {
  const staged = stagedPath(binary)
  const file = await openStaged(staged)
  let open = true
  const close = () => {
    if (open) file.close()
    open = false
  }
  try {
    const url = `${downloadUrl}/v${version}/${asset}`
    const sums = await (await get(fetcher, `${url}.sha256`, DOWNLOAD_TIMEOUT_MS)).text()
    const [expected, name] = sums.trim().split(/\s+/)
    if (!SHA256_HEX.test(expected) || name?.replace(/^\*/, '') !== asset) {
      throw new Error(`${url}.sha256 holds no SHA-256 of ${asset}`)
    }
    const hash = createSha256()
    const response = await get(fetcher, url, DOWNLOAD_TIMEOUT_MS)
    for await (const chunk of response.body) {
      hash.update(chunk)
      await writeAll(file, chunk)
    }
    await file.syncData()
    close()
    if (hash.digest() !== expected) {
      throw new Error(`the checksum of ${asset} ${version} does not match`)
    }
    await Deno.chmod(staged, 0o755)
    const reported = await reportedVersion(staged)
    if (reported !== version) {
      throw new Error(
        `the downloaded binary reports the version ${JSON.stringify(reported)}, not ${version}`,
      )
    }
    return staged
  } catch (error) {
    close()
    await removeIfExists(staged)
    throw error
  }
}

export const swapBinary = async (binary, staged) => {
  const previous = previousPath(binary)
  await removeIfExists(previous)
  await Deno.link(binary, previous)
  await Deno.rename(staged, binary)
  await syncDirectory(dirname(binary))
  return previous
}

export const restorePrevious = async (binary) => {
  await Deno.rename(previousPath(binary), binary)
  await syncDirectory(dirname(binary))
}
