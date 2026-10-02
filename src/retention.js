import { dayOf } from './days.js'
import {
  appDir,
  dayDir,
  isSummaryOnlyDay,
  keepOnlySummary,
  listApps,
  listDays,
} from './column-store.js'
import { listDirectory, removeIfExists } from './fs-utils.js'
import { join } from './paths.js'

export const DEFAULT_MIN_FREE = '10%'

const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }

export const parseMinFree = (text) => {
  const value = String(text).trim().toUpperCase()
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(value)
  if (percent) {
    const amount = Number(percent[1])
    if (amount > 0 && amount < 100) return { percent: amount }
  }
  const size = /^(\d+(?:\.\d+)?)(B|KB|MB|GB|TB)$/.exec(value)
  if (size && Number(size[1]) > 0) return { bytes: Math.round(Number(size[1]) * UNITS[size[2]]) }
  throw new Error(`--min-free "${text}" is not a size - use a percent like 10% or a size like 5GB`)
}

export const minFreeBytes = (minFree, totalBytes) =>
  minFree.percent === undefined ? minFree.bytes : Math.ceil(totalBytes * minFree.percent / 100)

export const parseDf = (text) => {
  const lines = text.trim().split('\n')
  const fields = lines.at(-1).trim().split(/\s+/)
  const totalKb = Number(fields[1])
  const freeKb = Number(fields[3])
  if (lines.length < 2 || !Number.isFinite(totalKb) || !Number.isFinite(freeKb)) {
    throw new Error(`df printed an unexpected answer: ${text.trim()}`)
  }
  return { totalBytes: totalKb * 1024, freeBytes: freeKb * 1024 }
}

export const diskUsage = async (path) => {
  const { code, stdout, stderr } = await new Deno.Command('df', {
    args: ['-Pk', path],
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const decoder = new TextDecoder()
  if (code !== 0) throw new Error(`df failed: ${decoder.decode(stderr).trim()}`)
  return parseDf(decoder.decode(stdout))
}

const TRASH_SUFFIX = '.trash'

const removeTrash = async (dataDir) => {
  for (const app of await listApps(dataDir)) {
    for (const entry of await listDirectory(appDir(dataDir, app))) {
      if (entry.name.endsWith(TRASH_SUFFIX)) {
        await removeIfExists(join(appDir(dataDir, app), entry.name), { recursive: true })
      }
    }
  }
}

export const listStoredDays = async (dataDir) => {
  const days = []
  for (const app of await listApps(dataDir)) {
    for (const day of await listDays(dataDir, app)) days.push({ app, day })
  }
  return days.sort((a, b) => (a.day === b.day ? (a.app < b.app ? -1 : 1) : a.day < b.day ? -1 : 1))
}

const removalOrder = async (dataDir, today) => {
  const withRecords = []
  const summaryOnly = []
  for (const entry of await listStoredDays(dataDir)) {
    if (entry.day >= today) continue
    if (await isSummaryOnlyDay(dayDir(dataDir, entry.app, entry.day))) {
      summaryOnly.push({ ...entry, summaryOnly: true })
    } else {
      withRecords.push({ ...entry, summaryOnly: false })
    }
  }
  return [...withRecords, ...summaryOnly]
}

const removeDay = async (dataDir, app, day) => {
  const trash = join(appDir(dataDir, app), `${day}${TRASH_SUFFIX}`)
  await Deno.rename(join(appDir(dataDir, app), day), trash)
  await removeIfExists(trash, { recursive: true })
}

const tryKeepOnlySummary = async (path, log) => {
  try {
    return await keepOnlySummary(path)
  } catch (error) {
    log?.warn(`Cannot keep the daily summary of ${path}: ${error.message}`)
    return false
  }
}

export const enforceRetention = async (
  { dataDir, minFree, usage = diskUsage, now = Date.now(), log },
) => {
  let current = await usage(dataDir)
  const needed = minFreeBytes(minFree, current.totalBytes)
  const summarized = []
  const removed = []
  const result = () => ({ ...current, neededBytes: needed, summarized, removed })
  if (current.freeBytes >= needed) return result()
  await removeTrash(dataDir)
  const today = dayOf(now)
  const enough = async () => {
    current = await usage(dataDir)
    return current.freeBytes >= needed
  }
  const summarize = async () => {
    for (const { app, day, summaryOnly } of await removalOrder(dataDir, today)) {
      if (summaryOnly) return
      if (!(await tryKeepOnlySummary(dayDir(dataDir, app, day), log))) continue
      summarized.push(`${app}/${day}`)
      log?.info(`Removed the records of ${app}/${day} to keep free disk space, kept its summary`)
      if (await enough()) return
    }
  }
  const remove = async (withSummaryOnly) => {
    for (const { app, day, summaryOnly } of await removalOrder(dataDir, today)) {
      if (summaryOnly !== withSummaryOnly) continue
      await removeDay(dataDir, app, day)
      removed.push(`${app}/${day}`)
      log?.info(`Removed ${app}/${day} to keep free disk space`)
      if (await enough()) return
    }
  }
  await summarize()
  if (current.freeBytes < needed) await remove(false)
  if (current.freeBytes < needed) await remove(true)
  if (current.freeBytes < needed) {
    log?.warn(
      `Free disk space is ${current.freeBytes} bytes, below ${needed} bytes, and no older day is left to remove`,
    )
  }
  return result()
}
