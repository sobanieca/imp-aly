export const NULL_LABEL = '(none)'

export const labelOf = (
  value,
) => (value === null || value === undefined ? NULL_LABEL : String(value))

export const indexBy = (rows, key) => new Map(rows.map((row) => [labelOf(row[key]), row]))
