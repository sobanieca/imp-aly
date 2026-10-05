import { buildManifest, readFormat } from '../dev/versions-manifest.js'
import { checkDataFormat, DATA_FORMAT, FORMAT_FILE } from '../src/data-format.js'
import { updateServiceFile, updateTimerFile } from '../src/service.js'
import { sha256Hex } from '../src/sha256.js'
import {
  addSkipped,
  assetName,
  compareVersions,
  isCompatible,
  lockUpdates,
  parseManifest,
  parseVersion,
  pickUpdate,
  previousPath,
  readSkipped,
  restorePrevious,
  stageBinary,
  stagedPath,
  swapBinary,
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

const releaseFiles = (version, bytes, sum = sha256Hex(bytes)) => ({
  [`https://dl.test/v${version}/imp-aly-linux-x64`]: bytes,
  [`https://dl.test/v${version}/imp-aly-linux-x64.sha256`]: `${sum}  imp-aly-linux-x64\n`,
})

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

Deno.test('a compatible version keeps the minor before 1.0.0 and the major after it', () => {
  assert(isCompatible('0.1.0', '0.1.5'))
  assert(!isCompatible('0.1.0', '0.2.0'))
  assert(!isCompatible('0.9.0', '1.0.0'))
  assert(isCompatible('1.2.0', '1.9.3'))
  assert(!isCompatible('1.2.0', '2.0.0'))
})

Deno.test('the update is the newest compatible version with the same data format', () => {
  const versions = parseManifest({
    versions: [
      { version: '0.2.0', format: 2 },
      { version: '0.1.4', format: 2 },
      { version: '0.1.3', format: 1 },
      { version: '0.1.2', format: 1 },
      { version: '0.1.0', format: 1 },
      { version: 'nope', format: 1 },
      { version: '0.1.9' },
    ],
  })
  assertEquals(versions.length, 5)
  assertEquals(pickUpdate({ current: '0.1.0', format: 1, versions }), {
    target: '0.1.3',
    skipped: [],
    newest: '0.2.0',
  })
  assertEquals(pickUpdate({ current: '0.1.0', format: 1, versions, skipped: ['0.1.3'] }), {
    target: '0.1.2',
    skipped: ['0.1.3'],
    newest: '0.2.0',
  })
  assertEquals(pickUpdate({ current: '0.2.0', format: 2, versions }), {
    target: null,
    skipped: [],
    newest: null,
  })
  assertThrows(() => parseManifest({}), /"versions" array/)
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
    const options = { binary, downloadUrl: 'https://dl.test', asset: 'imp-aly-linux-x64' }
    const bytes = fakeBinary('0.1.1')
    await assertRejects(
      () =>
        stageBinary({
          ...options,
          version: '0.1.1',
          fetcher: fakeReleases(releaseFiles('0.1.1', bytes, sha256Hex(new Uint8Array(1)))),
        }),
      /checksum of imp-aly-linux-x64 0.1.1 does not match/,
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
    await assertRejects(() => checkDataFormat(dir), /has the data format 2/)
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
  assert(/\nExecStart=.* update\n/.test(service))
  assert(/\nStateDirectory=imp-aly-update\n/.test(service))
  assert(/\nReadWritePaths=\S+\n/.test(service))
  const timer = updateTimerFile()
  assert(/\nOnCalendar=daily\n/.test(timer))
  assert(/\nRandomizedDelaySec=6h\n/.test(timer))
  assert(/\nWantedBy=timers.target\n/.test(timer))
})
