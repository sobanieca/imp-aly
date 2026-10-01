import { listClosedSegments, openWal, segmentFileName, writeAppliedSegment } from '../src/wal.js'
import { assertEquals, assertRejects, temporaryDir } from './assert.js'

Deno.test('appends are grouped and segments close on rotation', async () => {
  const dir = await temporaryDir()
  const closed = []
  const wal = await openWal({ dir, segmentMs: 60_000, onSegment: (id) => closed.push(id) })
  await Promise.all([wal.append('a\n'), wal.append('b\n'), wal.append('c\n')])
  assertEquals(await listClosedSegments(dir), [])
  await wal.close()
  const segments = await listClosedSegments(dir)
  assertEquals(segments.map((segment) => segment.id), [1])
  assertEquals(closed, [1])
  assertEquals(await Deno.readTextFile(segments[0].path), 'a\nb\nc\n')
  await assertRejects(() => wal.append('d\n'), /closed/)
  await Deno.remove(dir, { recursive: true })
})

Deno.test('a full segment closes and the next one starts', async () => {
  const dir = await temporaryDir()
  const wal = await openWal({ dir, segmentMs: 60_000, segmentBytes: 4 })
  await wal.append('abcd\n')
  await wal.append('e\n')
  await wal.close()
  assertEquals((await listClosedSegments(dir)).map((segment) => segment.id), [1, 2])
  await Deno.remove(dir, { recursive: true })
})

Deno.test('an open segment of a crash is closed, and ids never repeat', async () => {
  const dir = await temporaryDir()
  await Deno.writeTextFile(`${dir}/${segmentFileName(3, 'open')}`, 'x\n')
  await writeAppliedSegment(dir, 7)
  const wal = await openWal({ dir, segmentMs: 60_000 })
  await wal.append('y\n')
  await wal.close()
  assertEquals((await listClosedSegments(dir)).map((segment) => segment.id), [3, 8])
  await Deno.remove(dir, { recursive: true })
})

Deno.test('the timer closes a segment with data', async () => {
  const dir = await temporaryDir()
  const wal = await openWal({ dir, segmentMs: 30 })
  await wal.append('a\n')
  await new Promise((resolve) => setTimeout(resolve, 120))
  assertEquals((await listClosedSegments(dir)).length, 1)
  await wal.close()
  await Deno.remove(dir, { recursive: true })
})
