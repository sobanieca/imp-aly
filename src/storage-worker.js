import { logger } from './logger.js'
import { parseMinFree } from './retention.js'
import { createStorage } from './storage.js'

let storage = null

let running = null

self.onmessage = (event) => {
  const message = event.data
  if (message.type === 'init') {
    logger.setDebug(Boolean(message.debug))
    logger.setQuiet(Boolean(message.quiet))
    storage = createStorage({
      dataDir: message.dataDir,
      minFree: message.minFree ? parseMinFree(message.minFree) : null,
      sealDelayMs: message.sealDelayMs,
      maintenanceMs: message.maintenanceMs,
      log: logger,
      onStatus: (status) => self.postMessage({ type: 'status', status }),
    })
    running = storage.run()
    return
  }
  if (message.type === 'segment') {
    storage?.wake()
    return
  }
  if (message.type === 'restore') {
    const reply = (fields) => self.postMessage({ type: 'restored', id: message.id, ...fields })
    if (!storage) return reply({ error: 'the storage worker is not ready', status: 503 })
    storage.restore(message.path).then(
      (result) => reply({ result }),
      (error) => reply({ error: error.message, status: error.status ?? 500 }),
    )
    return
  }
  if (message.type === 'stop') {
    storage?.stop()
    Promise.resolve(running).then(() => self.postMessage({ type: 'stopped' }))
  }
}
