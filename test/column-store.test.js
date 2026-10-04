import {
  appendRecords,
  appendTarget,
  readCommit,
  readDay,
  readGenerations,
  sealDay,
  tidyDay,
} from '../src/column-store.js'
import { assert, assertEquals, assertRejects, temporaryDir } from './assert.js'

const visits = [
  { type: 'page', visit: 'v1', at: 1, page: '/invoice', country: 'PL', plan: 'pro' },
  { type: 'page', visit: 'v2', at: 2, page: '/invoice/:id', country: 'PL', plan: 'pro' },
  { type: 'seen', visit: 'v3', at: 3, page: '/invoice', zone: 'a.b', country: 'EN' },
  { type: 'error', visit: 'v4', at: 4, page: '/invoice', country: 'PL', plan: 'free' },
]

const rowsOf = (day, columns) =>
  Array.from({ length: day.rows }, (_, row) => columns.map((column) => day.columns[column][row]))

Deno.test('an append writes one line per record in every column', async () => {
  const dir = await temporaryDir()
  const raw = `${dir}/raw-1`
  assert(await appendRecords({ dir: raw, segment: 1, records: visits.slice(0, 2) }))
  assert(await appendRecords({ dir: raw, segment: 2, records: visits.slice(2) }))
  assertEquals(await Deno.readTextFile(`${raw}/country.txt`), 'PL\nPL\nEN\nPL\n')
  assertEquals(await Deno.readTextFile(`${raw}/zone.txt`), '\n\na.b\n\n')
  assertEquals(await Deno.readTextFile(`${raw}/plan.txt`), 'pro\npro\n\nfree\n')
  const commit = await readCommit(raw)
  assertEquals(commit.rows, 4)
  assertEquals(commit.wal, 2)
  const day = await readDay(dir, ['visit', 'zone', 'name'])
  assertEquals(day.columns.visit, ['v1', 'v2', 'v3', 'v4'])
  assertEquals(day.columns.zone, [null, null, 'a.b', null])
  assertEquals(day.columns.name, [null, null, null, null])
  await Deno.remove(dir, { recursive: true })
})

Deno.test('a segment that is already applied is skipped', async () => {
  const dir = await temporaryDir()
  const raw = `${dir}/raw-1`
  assert(await appendRecords({ dir: raw, segment: 5, records: visits }))
  assert(!(await appendRecords({ dir: raw, segment: 5, records: visits })))
  assert(!(await appendRecords({ dir: raw, segment: 4, records: visits })))
  assertEquals((await readCommit(raw)).rows, 4)
  await Deno.remove(dir, { recursive: true })
})

Deno.test('a failed append reverts every column', async () => {
  const dir = await temporaryDir()
  const raw = `${dir}/raw-1`
  await appendRecords({ dir: raw, segment: 1, records: visits.slice(0, 2) })
  const before = {}
  for (const column of ['type', 'visit', 'page', 'country']) {
    before[column] = await Deno.readTextFile(`${raw}/${column}.txt`)
  }
  await Deno.mkdir(`${raw}/zone.txt`)
  await assertRejects(() => appendRecords({ dir: raw, segment: 2, records: visits.slice(2) }))
  for (const column of Object.keys(before)) {
    assertEquals(await Deno.readTextFile(`${raw}/${column}.txt`), before[column], column)
  }
  assertEquals((await readCommit(raw)).rows, 2)
  await Deno.remove(`${raw}/zone.txt`)
  assert(await appendRecords({ dir: raw, segment: 2, records: visits.slice(2) }))
  const day = await readDay(dir, ['visit', 'zone'])
  assertEquals(day.columns.visit, ['v1', 'v2', 'v3', 'v4'])
  assertEquals(day.columns.zone, [null, null, 'a.b', null])
  await Deno.remove(dir, { recursive: true })
})

Deno.test('a torn tail after a crash is ignored by readers and cut by the next append', async () => {
  const dir = await temporaryDir()
  const raw = `${dir}/raw-1`
  await appendRecords({ dir: raw, segment: 1, records: visits.slice(0, 2) })
  await Deno.writeTextFile(`${raw}/visit.txt`, 'torn\nva', { append: true })
  assertEquals((await readDay(dir, ['visit'])).columns.visit, ['v1', 'v2'])
  await appendRecords({ dir: raw, segment: 2, records: visits.slice(2) })
  assertEquals(await Deno.readTextFile(`${raw}/visit.txt`), 'v1\nv2\nv3\nv4\n')
  await Deno.remove(dir, { recursive: true })
})

Deno.test('sealing sorts the rows, keeps them aligned and runs the values', async () => {
  const dir = await temporaryDir()
  const many = Array.from({ length: 200 }, (_, index) => ({
    ...visits[index % visits.length],
    visit: `v${index % 7}`,
    at: 1000 - index,
  }))
  await appendRecords({ dir: `${dir}/raw-1`, segment: 1, records: many })
  const columns = ['type', 'visit', 'at', 'page', 'zone', 'country', 'plan']
  const before = rowsOf(await readDay(dir, columns), columns).map((row) => JSON.stringify(row))
    .sort()
  assert(await sealDay(dir))
  const generations = await readGenerations(dir)
  assertEquals(generations.sealed, 1)
  assertEquals(generations.raws, [])
  const country = await Deno.readTextFile(`${dir}/sealed-1/country.rle`)
  assert(country.split('\n').length < 40, 'country runs are short')
  const meta = JSON.parse(await Deno.readTextFile(`${dir}/sealed-1/meta.json`))
  assertEquals(meta.plain, ['at'])
  assertEquals((await Deno.readTextFile(`${dir}/sealed-1/at.txt`)).split('\n').length, 201)
  const after = rowsOf(await readDay(dir, columns), columns).map((row) => JSON.stringify(row))
    .sort()
  assertEquals(after, before)
  const sortedPages = (await readDay(dir, ['page'])).columns.page
  assertEquals(sortedPages, [...sortedPages].sort())
  await Deno.remove(dir, { recursive: true })
})

const filesOf = async (dir) => {
  const files = {}
  for await (const entry of Deno.readDir(dir)) {
    files[entry.name] = await Deno.readTextFile(`${dir}/${entry.name}`)
  }
  return files
}

Deno.test('sealing in small chunks writes the same files as one chunk', async () => {
  const records = (offset) =>
    Array.from({ length: 200 }, (_, index) => ({
      ...visits[(index + offset) % visits.length],
      visit: `v${(index * 3 + offset) % 11}`,
      at: 5000 - index - offset,
    }))
  const seal = async (chunkRows) => {
    const dir = await temporaryDir()
    await appendRecords({ dir: `${dir}/raw-1`, segment: 1, records: records(0) })
    await sealDay(dir, { chunkRows })
    await appendRecords({ dir: `${dir}/raw-2`, segment: 2, records: records(1) })
    await sealDay(dir, { chunkRows })
    const files = await filesOf(`${dir}/sealed-2`)
    await Deno.remove(dir, { recursive: true })
    return files
  }
  const whole = await seal(1000)
  assertEquals(Object.keys(whole).sort(), [
    'at.txt',
    'country.rle',
    'meta.json',
    'page.rle',
    'plan.rle',
    'summary-counts.tsv',
    'summary-tuples.tsv',
    'summary-visits.tsv',
    'type.rle',
    'visit.rle',
    'zone.rle',
  ])
  assertEquals(await seal(7), whole)
})

Deno.test('records that arrive after sealing are read and sealed again', async () => {
  const dir = await temporaryDir()
  await appendRecords({ dir: `${dir}/raw-1`, segment: 1, records: visits.slice(0, 2) })
  await sealDay(dir)
  const target = await appendTarget(dir)
  assertEquals(target, { dir: `${dir}/raw-2`, appliedWal: 1 })
  assert(!(await appendRecords({ ...target, segment: 1, records: visits })))
  assert(await appendRecords({ ...target, segment: 2, records: visits.slice(2) }))
  assertEquals((await readDay(dir, ['visit'])).columns.visit.sort(), ['v1', 'v2', 'v3', 'v4'])
  assert(await sealDay(dir))
  assertEquals((await readGenerations(dir)).sealed, 2)
  assertEquals((await readDay(dir, ['visit'])).columns.visit.sort(), ['v1', 'v2', 'v3', 'v4'])
  await Deno.remove(dir, { recursive: true })
})

Deno.test('leftovers of an interrupted seal are tidied', async () => {
  const dir = await temporaryDir()
  await appendRecords({ dir: `${dir}/raw-1`, segment: 1, records: visits })
  await sealDay(dir)
  await Deno.mkdir(`${dir}/sealed-9.tmp`)
  await Deno.mkdir(`${dir}/raw-1`)
  assertEquals((await readDay(dir, ['visit'])).rows, 4)
  await tidyDay(dir)
  const names = []
  for await (const entry of Deno.readDir(dir)) names.push(entry.name)
  assertEquals(names, ['sealed-1'])
  await Deno.remove(dir, { recursive: true })
})

Deno.test('a raw folder before its first commit reads as empty', async () => {
  const dir = await temporaryDir()
  await Deno.mkdir(`${dir}/raw-1`)
  await Deno.writeTextFile(`${dir}/raw-1/visit.txt`, 'v1\n')
  assertEquals(await readDay(dir, ['visit']), { rows: 0, columns: { visit: [] } })
  assertEquals(await readDay(`${dir}/missing`, ['visit']), { rows: 0, columns: { visit: [] } })
  await Deno.remove(dir, { recursive: true })
})
