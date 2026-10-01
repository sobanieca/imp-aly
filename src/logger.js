let debugEnabled = false

let quiet = false

const stamp = () => new Date().toISOString()

const format = (value) =>
  typeof value === 'string' ? value : Deno.inspect(value, { depth: 4, colors: false })

const write = (level, value) => {
  if (quiet) return
  const line = `${stamp()} ${level} ${format(value)}`
  if (level === 'ERROR' || level === 'WARN') console.error(line)
  else console.log(line)
}

export const logger = {
  info: (value) => write('INFO', value),
  warn: (value) => write('WARN', value),
  error: (value) => write('ERROR', value),
  debug: (value) => {
    if (debugEnabled) write('DEBUG', value)
  },
  plain: (text) => {
    if (!quiet) console.log(text)
  },
  setDebug: (value) => {
    debugEnabled = value
  },
  setQuiet: (value) => {
    quiet = value
  },
}
