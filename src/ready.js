export const MAX_READY_MS = 3_600_000

const stepOf = (bucket) => (bucket < 100 ? 1 : 10 ** (String(bucket).length - 2))

export const bucketOf = (value) => {
  const step = stepOf(value)
  return Math.floor(value / step) * step
}

export const isBucket = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_READY_MS && bucketOf(value) === value

export const bucketMiddle = (bucket) => {
  const step = stepOf(bucket)
  return step === 1 ? bucket : bucket + step / 2
}

export const createReady = () => ({
  count: 0,
  sum: 0,
  min: Infinity,
  max: -Infinity,
  buckets: new Map(),
})

export const addReadyValue = (ready, value) => {
  ready.count++
  ready.sum += value
  if (value < ready.min) ready.min = value
  if (value > ready.max) ready.max = value
  const bucket = bucketOf(value)
  ready.buckets.set(bucket, (ready.buckets.get(bucket) ?? 0) + 1)
}

export const mergeReady = (ready, { count, sum, min, max, buckets = [] }) => {
  ready.count += count
  ready.sum += sum
  if (min < ready.min) ready.min = min
  if (max > ready.max) ready.max = max
  for (const [bucket, bucketCount] of buckets) {
    ready.buckets.set(bucket, (ready.buckets.get(bucket) ?? 0) + bucketCount)
  }
}

export const readyToJson = (ready, withBuckets) => {
  const { count, sum, min, max } = ready
  return withBuckets
    ? { count, sum, min, max, buckets: sortedBuckets(ready) }
    : { count, sum, min, max }
}

export const sortedBuckets = (ready) => [...ready.buckets].sort((a, b) => a[0] - b[0])

export const readyPercentile = (ready, percent) => {
  const rank = Math.max(1, Math.ceil((percent / 100) * ready.count))
  let seen = 0
  for (const [bucket, count] of sortedBuckets(ready)) {
    seen += count
    if (seen >= rank) return bucketMiddle(bucket)
  }
  return null
}

export const readyShareUnder = (ready, limit) => {
  let under = 0
  for (const [bucket, count] of ready.buckets) {
    if (bucket < limit) under += count
  }
  return Math.round((under / ready.count) * 1000) / 10
}
