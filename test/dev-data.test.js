import { DEV_DATA_DIR, openDevData } from '../dev/dev-data.js'
import { assert, assertEquals } from './assert.js'

Deno.test('the demo keeps its data and its key in .dev-data of the repo', () => {
  assert(DEV_DATA_DIR.endsWith('/.dev-data'), DEV_DATA_DIR)
  assert(!DEV_DATA_DIR.startsWith(Deno.env.get('TMPDIR') ?? '/tmp'), DEV_DATA_DIR)
})

Deno.test('the demo data folder survives a restart, and a reset starts it again', async () => {
  const root = await Deno.makeTempDir({ prefix: 'imp-aly-dev-data-' })
  try {
    const first = await openDevData(root)
    assertEquals(first.fresh, true)
    assertEquals(first.dataDir, `${root}/data`)
    await Deno.writeTextFile(`${first.dataDir}/kept.txt`, 'records')
    assertEquals((await Deno.stat(`${root}/key`)).mode & 0o777, 0o600)

    const again = await openDevData(root)
    assertEquals(again.fresh, false)
    assertEquals(again.key, first.key)
    assertEquals(await Deno.readTextFile(`${again.dataDir}/kept.txt`), 'records')

    const reset = await openDevData(root, { reset: true })
    assertEquals(reset.fresh, true)
    assert(reset.key !== first.key, 'a reset makes a new key')
    assertEquals([...Deno.readDirSync(reset.dataDir)].length, 0)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a data folder without its key starts again', async () => {
  const root = await Deno.makeTempDir({ prefix: 'imp-aly-dev-data-' })
  try {
    await Deno.mkdir(`${root}/data`)
    await Deno.writeTextFile(`${root}/data/old.txt`, 'old')
    const opened = await openDevData(root)
    assertEquals(opened.fresh, true)
    assertEquals([...Deno.readDirSync(opened.dataDir)].length, 0)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
