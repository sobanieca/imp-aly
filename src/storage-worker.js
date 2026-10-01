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
  if (message.type === 'stop') {
    storage?.stop()
    Promise.resolve(running).then(() => self.postMessage({ type: 'stopped' }))
  }
}
