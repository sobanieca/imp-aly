const stampOf = async (path) => {
  const { mtime, size } = await Deno.stat(path)
  return `${mtime?.getTime() ?? ''}:${size}`
}

export const watchFiles = async ({ paths, intervalMs, onChange, log }) => {
  const read = async () => {
    const stamps = []
    for (const path of paths) stamps.push(await stampOf(path))
    return stamps.join(',')
  }
  let lastProblem = null
  const warn = (error) => {
    if (error.message !== lastProblem) {
      log?.warn(`Cannot check ${paths.join(', ')} for changes: ${error.message}`)
    }
    lastProblem = error.message
  }
  let known = null
  try {
    known = await read()
  } catch (error) {
    warn(error)
  }
  const check = async () => {
    try {
      const current = await read()
      lastProblem = null
      if (known === null) known = current
      if (current === known) return
      if (await onChange()) known = current
    } catch (error) {
      warn(error)
    }
  }
  let running = null
  const timer = setInterval(() => {
    running ??= check().finally(() => {
      running = null
    })
  }, intervalMs)
  return {
    stop: async () => {
      clearInterval(timer)
      await running
    },
  }
}
