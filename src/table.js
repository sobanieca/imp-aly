const cell = (value) => (value === null || value === undefined ? '-' : String(value))

export const formatTable = (columns, rows) => {
  const cells = rows.map((row) => columns.map((column) => cell(row[column])))
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((line) => line[index].length))
  )
  const isNumeric = columns.map((_, index) =>
    cells.length > 0 && cells.every((line) => /^-?\d+(\.\d+)?$|^-$/.test(line[index]))
  )
  const format = (line) =>
    line.map((text, index) =>
      isNumeric[index] ? text.padStart(widths[index]) : text.padEnd(widths[index])
    ).join('   ').trimEnd()
  return [format(columns), ...cells.map(format)].join('\n')
}
