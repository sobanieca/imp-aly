import { expect, test } from 'imp/test'
import { runTransaction } from '../src/lib/vault.js'

const fakeTransaction = () => {
  const tx = {
    aborted: 0,
    error: null,
    objectStore: () => ({}),
    abort: () => {
      tx.aborted++
      queueMicrotask(() => tx.onabort?.())
    },
  }
  return tx
}

test('an error in a change aborts the transaction and reaches the caller', async () => {
  const tx = fakeTransaction()
  let caught = null
  try {
    await runTransaction(tx, () => {
      throw new Error('a new server needs its key')
    })
  } catch (error) {
    caught = error
  }
  expect(caught?.message).toEqual('a new server needs its key')
  expect(tx.aborted).toEqual(1)
})

test('a transaction that the browser aborts gives its error', async () => {
  const tx = fakeTransaction()
  tx.abort = () => {
    tx.aborted++
    throw new Error('the transaction has finished')
  }
  const failure = new Error('QuotaExceededError')
  let caught = null
  try {
    await runTransaction(tx, async () => {
      tx.error = failure
      queueMicrotask(() => tx.onabort())
      await Promise.resolve()
      return 'done'
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toEqual(failure)
  expect(tx.aborted).toEqual(1)
})

test('a transaction that completes gives the result', async () => {
  const tx = fakeTransaction()
  const result = await runTransaction(tx, () => {
    queueMicrotask(() => tx.oncomplete())
    return 'saved'
  })
  expect(result).toEqual('saved')
  expect(tx.aborted).toEqual(0)
})
