import { runQuery } from './query.js'

self.onmessage = async (event) => {
  const { id, dataDir, query } = event.data
  try {
    self.postMessage({ id, result: await runQuery({ dataDir, query }) })
  } catch (error) {
    self.postMessage({ id, error: error.message, status: error.status ?? 500 })
  }
}
