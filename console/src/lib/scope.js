import { computed, initState, useState } from 'imp/state'
import { serversOfApp } from './catalog.js'
import { DEFAULT_PRESET, isPreset, presetRange, todayUtc } from './ranges.js'
import { readStored, writeStored } from './storage.js'

const STORAGE_KEY = 'imp-aly.console.scope'

const SCOPE_STATES = [
  'aly.catalog',
  'aly.scope.app',
  'aly.scope.period',
  'aly.scope.tick',
  'aly.scope.today',
]

const TODAY_CHECK_MS = 60_000

const isRange = (value) =>
  typeof value?.start === 'string' && typeof value?.end === 'string' && value.start <= value.end

export const periodOf = (value) => {
  if (isPreset(value?.preset)) return { preset: value.preset }
  if (isRange(value)) return { start: value.start, end: value.end }
  return { preset: DEFAULT_PRESET }
}

export const rangeOf = (period, today) =>
  period.preset ? presetRange(period.preset, today) : { start: period.start, end: period.end }

export const syncToday = (today, now = Date.now()) => {
  const day = todayUtc(now)
  if (today.get() !== day) today.set(day)
}

const watchToday = (self, today) => {
  const check = () => syncToday(today)
  const timer = setInterval(check, TODAY_CHECK_MS)
  self.abortSignal.addEventListener('abort', () => clearInterval(timer))
  globalThis.document?.addEventListener('visibilitychange', check, { signal: self.abortSignal })
}

const readSaved = () => {
  const value = readStored(STORAGE_KEY, {})
  return value && typeof value === 'object' ? value : {}
}

export const initScope = (self) => {
  const saved = readSaved()
  const app = initState(
    self,
    'aly.scope.app',
    typeof saved.app === 'string' ? saved.app : undefined,
  )
  const period = initState(self, 'aly.scope.period', periodOf(saved.period))
  initState(self, 'aly.scope.tick', 0)
  watchToday(self, initState(self, 'aly.scope.today', todayUtc()))
  period.watch(self, (value) => {
    const clean = periodOf(value)
    if (JSON.stringify(clean) !== JSON.stringify(value)) period.set(clean)
  })
  const save = () => writeStored(STORAGE_KEY, { app: app.get(), period: period.get() })
  for (const state of [app, period]) state.watch(self, save)
  return { app, period }
}

export const useScope = (self) =>
  computed(
    SCOPE_STATES.map((name) => useState(self, name)),
    (catalog, app, period, tick, today) => {
      const clean = periodOf(period)
      const range = rangeOf(clean, today)
      const servers = serversOfApp(catalog, app)
      return { servers, app, from: range.start, to: range.end, preset: clean.preset, tick, today }
    },
  )
