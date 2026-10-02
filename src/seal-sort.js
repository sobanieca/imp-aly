import { removeIfExists } from './fs-utils.js'
import { openLineReader, openLineWriter, openValueReader } from './line-files.js'
import { join } from './paths.js'

export const SEAL_CHUNK_ROWS = 250_000

export const MAX_SORT_RUNS = 64

const MERGE_BLOCK_ROWS = 4_096

const compareText = (a, b) => {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}

const ranksOf = (values) => {
  const rankOf = new Map(
    [...new Set(values)].sort(compareText).map((value, rank) => [value, rank]),
  )
  const ranks = new Uint32Array(values.length)
  for (let row = 0; row < values.length; row++) ranks[row] = rankOf.get(values[row])
  return ranks
}

const numbersOf = (values) => {
  const numbers = new Float64Array(values.length)
  for (let row = 0; row < values.length; row++) {
    numbers[row] = values[row] === null ? -Infinity : Number(values[row])
  }
  return numbers
}

const sortChunk = (columns, count, textKeys, numberKey) => {
  const ranks = textKeys.map((key) => ranksOf(columns[key]))
  const numbers = numbersOf(columns[numberKey])
  const order = new Uint32Array(count)
  for (let row = 0; row < count; row++) order[row] = row
  order.sort((a, b) => {
    for (const rank of ranks) {
      const difference = rank[a] - rank[b]
      if (difference !== 0) return difference
    }
    return numbers[a] - numbers[b] || a - b
  })
  return order
}

async function* readChunks(parts, chunkRows) {
  for (const part of parts) {
    const readers = []
    try {
      for (const open of part.openers) readers.push(await open())
      for (let start = 0; start < part.rows; start += chunkRows) {
        const count = Math.min(chunkRows, part.rows - start)
        const columns = []
        for (const reader of readers) columns.push(await reader.take(count))
        yield { columns, count }
      }
      for (const reader of readers) await reader.finish()
    } finally {
      for (const reader of readers) reader.close()
    }
  }
}

const writeLines = async (path, write) => {
  const writer = await openLineWriter(path)
  try {
    await write(writer)
  } catch (error) {
    writer.abort()
    throw error
  }
  await writer.close()
}

const runPath = (dir, run, column) => join(dir, `sort-${run}-${column}.txt`)

const writeRun = async (dir, run, columns, order) => {
  for (let column = 0; column < columns.length; column++) {
    const values = columns[column]
    const lines = new Array(order.length)
    for (let position = 0; position < order.length; position++) {
      lines[position] = values[order[position]] ?? ''
    }
    await writeLines(runPath(dir, run, column), (writer) => {
      writer.write(`${lines.join('\n')}\n`)
      return writer.flush()
    })
  }
}

const memorySource = ({ columns, order }, index) => {
  let position = 0
  const source = {
    index,
    columns,
    row: order.length ? order[0] : -1,
    advance: () => {
      position++
      source.row = position < order.length ? order[position] : -1
      return null
    },
    close: () => {},
  }
  return source
}

const fileSource = async ({ dir, run, rows, columnCount, index }) => {
  const readers = []
  try {
    for (let column = 0; column < columnCount; column++) {
      readers.push(await openValueReader(runPath(dir, run, column)))
    }
  } catch (error) {
    for (const reader of readers) reader.close()
    throw error
  }
  let left = rows
  let size = 0
  const source = {
    index,
    columns: [],
    row: -1,
    advance: () => {
      source.row++
      if (source.row < size) return null
      return fill()
    },
    close: () => {
      for (const reader of readers) reader.close()
    },
  }
  const fill = async () => {
    size = Math.min(MERGE_BLOCK_ROWS, left)
    left -= size
    const columns = []
    for (const reader of readers) columns.push(size ? await reader.take(size) : [])
    source.columns = columns
    source.row = size ? 0 : -1
  }
  await fill()
  return source
}

const createHeap = (before) => {
  const items = []
  const down = (start) => {
    let index = start
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let first = index
      if (left < items.length && before(items[left], items[first])) first = left
      if (right < items.length && before(items[right], items[first])) first = right
      if (first === index) return
      const item = items[index]
      items[index] = items[first]
      items[first] = item
      index = first
    }
  }
  return {
    get size() {
      return items.length
    },
    top: () => items[0],
    build: (sources) => {
      items.push(...sources)
      for (let index = (items.length >> 1) - 1; index >= 0; index--) down(index)
    },
    settle: () => down(0),
    pop: () => {
      const last = items.pop()
      if (items.length) {
        items[0] = last
        down(0)
      }
    },
  }
}

const sourceOrder = (textKeys, numberKey) => (a, b) => {
  for (const key of textKeys) {
    const left = a.columns[key][a.row]
    const right = b.columns[key][b.row]
    if (left !== right) return compareText(left, right) < 0
  }
  const left = a.columns[numberKey][a.row]
  const right = b.columns[numberKey][b.row]
  if (left !== right) {
    if (left === null) return true
    if (right === null) return false
    return Number(left) < Number(right)
  }
  return a.index < b.index
}

const toPlain = async (dir, column) => {
  const path = join(dir, `${column}.rle`)
  const reader = await openLineReader(path)
  try {
    await writeLines(join(dir, `${column}.txt`), async (writer) => {
      for (let block = await reader.readBlock(); block; block = await reader.readBlock()) {
        for (const line of block) {
          const tab = line.indexOf('\t')
          const value = `${line.slice(tab + 1)}\n`
          for (let count = Number(line.slice(0, tab)); count > 0; count--) {
            writer.write(value)
            if (writer.full) await writer.flush()
          }
        }
      }
    })
  } finally {
    reader.close()
  }
  await removeIfExists(path)
}

export const sortDay = async ({
  parts,
  rows,
  rowColumns,
  columns,
  sortColumns,
  numberColumn,
  dir,
  chunkRows = SEAL_CHUNK_ROWS,
  onRows = () => {},
}) => {
  const textKeys = sortColumns.map((column) => rowColumns.indexOf(column))
  const numberKey = rowColumns.indexOf(numberColumn)
  const chunkSize = Math.max(chunkRows, Math.ceil(rows / MAX_SORT_RUNS))
  const sourceParts = parts.map((part) => ({
    rows: part.rows,
    openers: rowColumns.map((column) => () => part.open(column)),
  }))
  const runs = []
  let last = { columns: rowColumns.map(() => []), order: new Uint32Array(0) }
  let read = 0
  try {
    for await (const { columns, count } of readChunks(sourceParts, chunkSize)) {
      onRows(columns, count)
      const order = sortChunk(columns, count, textKeys, numberKey)
      read += count
      if (read < rows) {
        await writeRun(dir, runs.length, columns, order)
        runs.push(count)
      } else {
        last = { columns, order }
      }
    }
    if (read !== rows) throw new Error(`the day holds ${read} rows, expected ${rows}`)
    const outputs = columns.map((column) => ({
      column,
      position: rowColumns.indexOf(column),
      value: null,
      count: 0,
      runs: 0,
    }))
    const sources = []
    try {
      for (let run = 0; run < runs.length; run++) {
        sources.push(
          await fileSource({
            dir,
            run,
            rows: runs[run],
            columnCount: rowColumns.length,
            index: run,
          }),
        )
      }
      sources.push(memorySource(last, runs.length))
      const writers = []
      try {
        for (const output of outputs) {
          writers.push(await openLineWriter(join(dir, `${output.column}.rle`)))
        }
        const heap = createHeap(sourceOrder(textKeys, numberKey))
        heap.build(sources.filter((source) => source.row !== -1))
        while (heap.size) {
          const source = heap.top()
          for (let index = 0; index < outputs.length; index++) {
            const output = outputs[index]
            const value = source.columns[output.position][source.row]
            if (output.count > 0 && value === output.value) {
              output.count++
              continue
            }
            const writer = writers[index]
            if (output.count > 0) writer.write(`${output.count}\t${output.value ?? ''}\n`)
            output.value = value
            output.count = 1
            output.runs++
            if (writer.full) await writer.flush()
          }
          const filling = source.advance()
          if (filling) await filling
          if (source.row === -1) heap.pop()
          else heap.settle()
        }
        for (let index = 0; index < outputs.length; index++) {
          const output = outputs[index]
          if (output.count > 0) writers[index].write(`${output.count}\t${output.value ?? ''}\n`)
          await writers[index].close()
        }
      } catch (error) {
        for (const writer of writers) writer.abort()
        throw error
      }
    } finally {
      for (const source of sources) source.close()
    }
    const plain = []
    for (const output of outputs) {
      if (output.runs * 2 > rows) {
        plain.push(output.column)
        await toPlain(dir, output.column)
      }
    }
    return plain
  } finally {
    for (let run = 0; run < runs.length; run++) {
      for (let column = 0; column < rowColumns.length; column++) {
        await removeIfExists(runPath(dir, run, column))
      }
    }
  }
}
