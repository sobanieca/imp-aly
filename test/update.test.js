import { buildManifest, readFormat } from '../dev/versions-manifest.js'
import { checkDataFormat, DATA_FORMAT, FORMAT_FILE } from '../src/data-format.js'
import { updateServiceFile, updateTimerFile } from '../src/service.js'
import { sha256Hex } from '../src/sha256.js'
import {
  addSkipped,
  assetName,
  checkInstalled,
  compareVersions,
  fetchPublishDates,
  isAutoCompatible,
  lockUpdates,
  MIN_RELEASE_AGE_DAYS,
  parseManifest,
  parseReleases,
  parseVersion,
  pickUpdate,
  previousPath,
  readSkipped,
  restorePrevious,
  stageBinary,
  stagedPath,
  swapBinary,
  withPublishDates,
} from '../src/update.js'
import { assert, assertEquals, assertRejects, assertThrows } from './assert.js'

const exists = async (path) => {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

const fakeBinary = (version) => new TextEncoder().encode(`#!/bin/sh\necho ${version}\n`)

const fakeReleases = (files) => (url) => {
  const body = files[url]
  return Promise.resolve(
    body === undefined ? new Response('not found', { status: 404 }) : new Response(body),
  )
}

const DAY_MS = 86_400_000

const releaseFiles = (
  version,
  bytes,
  { sum = sha256Hex(bytes), name = 'imp-aly-linux-x64' } = {},
) => {
  const url = `https://dl.test/v${version}/imp-aly-linux-x64`
  return { [url]: bytes, [`${url}.sha256`]: `${sum}  ${name}\n` }
}

const withBinary = async (task) => {
  const dir = await Deno.makeTempDir()
  const binary = `${dir}/imp-aly`
  await Deno.writeFile(binary, fakeBinary('0.1.0'), { mode: 0o755 })
  try {
    await task({ dir, binary })
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test('versions parse and compare as numbers', () => {
  assertEquals(parseVersion('1.10.3'), [1, 10, 3])
  assertEquals(parseVersion('1.2'), null)
  assertEquals(parseVersion('01.2.3'), null)
  assertEquals(parseVersion('1.2.3-beta'), null)
  assert(compareVersions('0.1.10', '0.1.9') > 0)
  assert(compareVersions('1.0.0', '0.9.9') > 0)
  assertEquals(compareVersions('2.3.4', '2.3.4'), 0)
})

Deno.test('the timer stays in the minor version before 1.0.0 and in the major version after it', () => {
  assert(isAutoCompatible('0.1.0', '0.1.5'))
  assert(!isAutoCompatible('0.1.0', '0.2.0'))
  assert(!isAutoCompatible('0.9.0', '1.0.0'))
  assert(isAutoCompatible('1.2.0', '1.9.3'))
  assert(isAutoCompatible('1.2.0', '1.2.1'))
  assert(!isAutoCompatible('1.2.0', '2.0.0'))
})

const NOW = Date.parse('2026-10-09T12:00:00Z')

const daysAgo = (days) => NOW - days * DAY_MS

const listedVersions = () =>
  parseManifest({
    versions: [
      { version: '1.0.0', format: 1 },
      { version: '0.3.0', format: 2 },
      { version: '0.2.0', format: 1 },
      { version: '0.1.4', format: 1 },
      { version: '0.1.3', format: 1 },
      { version: '0.1.2', format: 1 },
      { version: '0.1.0', format: 1 },
      { version: '0.0.9', format: 1 },
      { version: 'nope', format: 1 },
      { version: '0.1.9' },
    ],
  })

const published = new Map([
  ['1.0.0', daysAgo(30)],
  ['0.3.0', daysAgo(30)],
  ['0.2.0', daysAgo(30)],
  ['0.1.4', daysAgo(2)],
  ['0.1.3', daysAgo(MIN_RELEASE_AGE_DAYS + 1)],
  ['0.1.2', daysAgo(MIN_RELEASE_AGE_DAYS + 3)],
  ['0.0.9', daysAgo(90)],
])

Deno.test('a manual update installs the newest newer version with the same data format', () => {
  const versions = listedVersions()
  assertEquals(versions.length, 8)
  assertEquals(pickUpdate({ current: '0.1.0', format: 1, versions }), {
    target: '1.0.0',
    held: [],
  })
  assertEquals(pickUpdate({ current: '0.1.0', format: 2, versions }), {
    target: '0.3.0',
    held: [{ version: '1.0.0', reason: 'format', published: null }],
  })
  assertEquals(
    pickUpdate({ current: '0.1.0', format: 1, versions, skipped: ['1.0.0'] }),
    {
      target: '0.2.0',
      held: [
        { version: '1.0.0', reason: 'skipped', published: null },
        { version: '0.3.0', reason: 'format', published: null },
      ],
    },
  )
  assertEquals(pickUpdate({ current: '1.0.0', format: 1, versions }), { target: null, held: [] })
  assertThrows(() => parseManifest({}), /"versions" array/)
})

Deno.test('the timer installs only a version of the same minor before 1.0.0, published over 7 days ago', () => {
  const versions = withPublishDates(listedVersions(), published)
  const auto = { current: '0.1.0', format: 1, versions, auto: true, now: NOW }
  const choice = pickUpdate(auto)
  assertEquals(choice.target, '0.1.3')
  assertEquals(choice.held.map(({ version, reason }) => [version, reason]), [
    ['1.0.0', 'major'],
    ['0.3.0', 'format'],
    ['0.2.0', 'major'],
    ['0.1.4', 'age'],
  ])
  assertEquals(choice.held[3].published, daysAgo(2))
  assertEquals(pickUpdate({ ...auto, skipped: ['0.1.3'] }).target, '0.1.2')
  assertEquals(pickUpdate({ ...auto, now: daysAgo(MIN_RELEASE_AGE_DAYS - 1) }).target, null)
  assertEquals(pickUpdate({ ...auto, now: NOW + 6 * DAY_MS }).target, '0.1.4')
  assertEquals(pickUpdate({ ...auto, current: '0.1.4' }).target, null)
  assertEquals(pickUpdate({ ...auto, versions: listedVersions() }).target, null)
  assertEquals(pickUpdate({ ...auto, current: '0.2.0' }).target, null)
})

Deno.test('the timer stays in the major version from 1.0.0', () => {
  const versions = withPublishDates(
    parseManifest({
      versions: [
        { version: '2.0.0', format: 1 },
        { version: '1.4.0', format: 1 },
        { version: '1.3.2', format: 1 },
      ],
    }),
    new Map([['2.0.0', daysAgo(60)], ['1.4.0', daysAgo(20)], ['1.3.2', daysAgo(40)]]),
  )
  const choice = pickUpdate({ current: '1.3.0', format: 1, versions, auto: true, now: NOW })
  assertEquals(choice.target, '1.4.0')
  assertEquals(choice.held.map(({ reason }) => reason), ['major'])
  assertEquals(pickUpdate({ current: '1.3.0', format: 1, versions, now: NOW }).target, '2.0.0')
})

Deno.test('the release age counts from more than 7 days after the publish date', () => {
  const at = Date.parse('2026-10-01T00:00:00Z')
  const versions = withPublishDates(
    [{ version: '0.1.1', format: 1 }],
    new Map([['0.1.1', at]]),
  )
  const pick = (now) => pickUpdate({ current: '0.1.0', format: 1, versions, auto: true, now })
  assertEquals(pick(at + MIN_RELEASE_AGE_DAYS * DAY_MS).target, null)
  assertEquals(pick(at + MIN_RELEASE_AGE_DAYS * DAY_MS + 1).target, '0.1.1')
})

Deno.test('an update is never a downgrade, also not by hand', () => {
  const versions = withPublishDates(listedVersions(), published)
  for (const auto of [false, true]) {
    const choice = pickUpdate({ current: '0.1.3', format: 1, versions, auto, now: NOW })
    assert(choice.held.every((entry) => compareVersions(entry.version, '0.1.3') > 0))
    assert(choice.target === null || compareVersions(choice.target, '0.1.3') > 0)
    assertEquals(
      pickUpdate({ current: '9.0.0', format: 1, versions, auto, now: NOW }),
      { target: null, held: [] },
    )
  }
})

Deno.test('the publish dates come from the GitHub API, without drafts and prereleases', async () => {
  const releases = [
    { tag_name: 'v0.1.2', published_at: '2026-10-01T10:00:00Z' },
    { tag_name: 'v0.1.3', published_at: null, draft: true },
    { tag_name: 'v0.1.4', published_at: '2026-10-02T10:00:00Z', prerelease: true },
    { tag_name: 'v0.1.5', published_at: 'soon' },
    { tag_name: 'next', published_at: '2026-10-02T10:00:00Z' },
    null,
  ]
  assertEquals([...parseReleases(releases)], [['0.1.2', Date.parse('2026-10-01T10:00:00Z')]])
  assertThrows(() => parseReleases({ message: 'API rate limit exceeded' }), /no list of releases/)
  const asked = []
  const dates = await fetchPublishDates({
    releasesUrl: 'https://api.test/releases',
    fetcher: (url, init) => {
      asked.push([url, init.headers.accept])
      return Promise.resolve(new Response(JSON.stringify(releases)))
    },
  })
  assertEquals(dates.get('0.1.2'), Date.parse('2026-10-01T10:00:00Z'))
  assertEquals(asked, [['https://api.test/releases', 'application/vnd.github+json']])
})

Deno.test('the asset name follows the platform', () => {
  assertEquals(assetName('linux', 'x86_64'), 'imp-aly-linux-x64')
  assertEquals(assetName('darwin', 'aarch64'), 'imp-aly-macos-arm64')
  assertThrows(() => assetName('windows', 'x86_64'), /no release for windows/)
})

Deno.test('an update stages a checked binary, swaps it in one step and can put the old one back', async () => {
  await withBinary(async ({ binary }) => {
    const bytes = fakeBinary('0.1.1')
    const staged = await stageBinary({
      binary,
      version: '0.1.1',
      fetcher: fakeReleases(releaseFiles('0.1.1', bytes)),
      downloadUrl: 'https://dl.test',
      asset: 'imp-aly-linux-x64',
    })
    assertEquals(staged, stagedPath(binary))
    const previous = await swapBinary(binary, staged)
    assertEquals(previous, previousPath(binary))
    assertEquals(new TextDecoder().decode(await Deno.readFile(binary)), '#!/bin/sh\necho 0.1.1\n')
    assertEquals((await Deno.stat(binary)).mode & 0o777, 0o755)
    assert(!(await exists(staged)))
    await restorePrevious(binary)
    assertEquals(new TextDecoder().decode(await Deno.readFile(binary)), '#!/bin/sh\necho 0.1.0\n')
    assert(!(await exists(previous)))
  })
})

Deno.test('an update refuses a download with a wrong checksum or a wrong version', async () => {
  await withBinary(async ({ binary }) => {
    const options = {
      binary,
      downloadUrl: 'https://dl.test',
      asset: 'imp-aly-linux-x64',
    }
    const bytes = fakeBinary('0.1.1')
    await assertRejects(
      () =>
        stageBinary({
          ...options,
          version: '0.1.1',
          fetcher: fakeReleases(
            releaseFiles('0.1.1', bytes, { sum: sha256Hex(new Uint8Array(1)) }),
          ),
        }),
      /checksum of imp-aly-linux-x64 0.1.1 does not match/,
    )
    assert(!(await exists(stagedPath(binary))))
    await assertRejects(
      () =>
        stageBinary({
          ...options,
          version: '0.1.1',
          fetcher: fakeReleases(releaseFiles('0.1.1', bytes, { name: 'imp-aly-macos-arm64' })),
        }),
      /holds no SHA-256 of imp-aly-linux-x64/,
    )
    assert(!(await exists(stagedPath(binary))))
    await assertRejects(
      () =>
        stageBinary({
          ...options,
          version: '0.1.2',
          fetcher: fakeReleases(releaseFiles('0.1.2', bytes)),
        }),
      /reports the version "0.1.1", not 0.1.2/,
    )
    assert(!(await exists(stagedPath(binary))))
    await assertRejects(
      () => stageBinary({ ...options, version: '0.1.3', fetcher: fakeReleases({}) }),
      /answered 404/,
    )
    assertEquals(new TextDecoder().decode(await Deno.readFile(binary)), '#!/bin/sh\necho 0.1.0\n')
  })
})

Deno.test('an update stops when another update replaced the binary since it started', async () => {
  await withBinary(async ({ dir, binary }) => {
    await checkInstalled(binary, '0.1.0')
    await Deno.writeFile(`${dir}/next`, fakeBinary('0.1.1'), { mode: 0o755 })
    const previous = await swapBinary(binary, `${dir}/next`)
    await assertRejects(() => checkInstalled(binary, '0.1.0'), /is imp-aly 0.1.1 now, not 0.1.0/)
    assertEquals(new TextDecoder().decode(await Deno.readFile(previous)), '#!/bin/sh\necho 0.1.0\n')
  })
})

Deno.test('the skip list and the update lock live in the state folder', async () => {
  const dir = `${await Deno.makeTempDir()}/state`
  try {
    assertEquals(await readSkipped(dir), [])
    await addSkipped(dir, '0.1.3')
    await addSkipped(dir, '0.1.3')
    assertEquals(await readSkipped(dir), ['0.1.3'])
    const lock = await lockUpdates(dir)
    await assertRejects(() => lockUpdates(dir), /another imp-aly update runs/)
    lock.close()
    ;(await lockUpdates(dir)).close()
  } finally {
    await Deno.remove(dir.replace(/\/state$/, ''), { recursive: true })
  }
})

Deno.test('the data folder keeps its format and refuses another one', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await checkDataFormat(dir)
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/${FORMAT_FILE}`)), {
      format: DATA_FORMAT,
    })
    await checkDataFormat(dir)
    await Deno.writeTextFile(`${dir}/${FORMAT_FILE}`, JSON.stringify({ format: DATA_FORMAT + 1 }))
    await assertRejects(
      () => checkDataFormat(dir),
      new RegExp(`has the data format ${DATA_FORMAT + 1}`),
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('the version list holds the tags with a matching version and a data format', async () => {
  assertEquals(readFormat('export const DATA_FORMAT = 3\n'), 3)
  assertEquals(readFormat(null), null)
  const files = {
    'v0.1.0:deno.json': '{"version":"0.1.0"}',
    'v0.1.1:deno.json': '{"version":"0.1.1"}',
    'v0.1.1:src/data-format.js': 'export const DATA_FORMAT = 1',
    'v0.1.2:deno.json': '{"version":"0.1.2"}',
    'v0.1.2:src/data-format.js': 'export const DATA_FORMAT = 1',
    'v0.1.3:deno.json': '{"version":"0.1.4"}',
    'v0.1.3:src/data-format.js': 'export const DATA_FORMAT = 1',
  }
  const manifest = await buildManifest({
    tags: ['v0.1.0', 'v0.1.1', 'v0.1.2', 'v0.1.3', 'vnext'],
    show: (tag, path) => Promise.resolve(files[`${tag}:${path}`] ?? null),
  })
  assertEquals(manifest, {
    versions: [{ version: '0.1.2', format: 1 }, { version: '0.1.1', format: 1 }],
  })
})

Deno.test('the update units run imp-aly update once a day', () => {
  const service = updateServiceFile()
  assert(/\nType=oneshot\n/.test(service))
  assert(/\nExecStart=.* update --auto\n/.test(service))
  assert(/\nStateDirectory=imp-aly-update\n/.test(service))
  assert(/\nReadWritePaths=\S+\n/.test(service))
  for (
    const line of [
      'ProtectSystem=strict',
      'NoNewPrivileges=true',
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
      'SystemCallArchitectures=native',
      'SystemCallFilter=@system-service',
      'CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_FOWNER',
    ]
  ) {
    assert(service.split('\n').includes(line), line)
  }
  const timer = updateTimerFile()
  assert(/\nOnCalendar=daily\n/.test(timer))
  assert(/\nRandomizedDelaySec=6h\n/.test(timer))
  assert(/\nWantedBy=timers.target\n/.test(timer))
})
