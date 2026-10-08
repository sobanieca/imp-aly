import { isSource } from '../src/names.js'
import { openSource, SOURCE_FILE } from '../src/source.js'
import { assert, assertEquals, assertRejects, temporaryDir } from './assert.js'

Deno.test('a data folder gets one random source id, and a damaged id stops the start', async () => {
  const dataDir = await temporaryDir()
  const other = await temporaryDir()
  const source = await openSource(dataDir)
  assert(isSource(source))
  assertEquals(await openSource(dataDir), source)
  assert((await openSource(other)) !== source)
  await Deno.writeTextFile(`${dataDir}/${SOURCE_FILE}`, JSON.stringify({ source: '../x' }))
  await assertRejects(() => openSource(dataDir), /does not hold a source id/)
  assert(!isSource('0123456789ABCDEF'))
  for (const dir of [dataDir, other]) await Deno.remove(dir, { recursive: true })
})
