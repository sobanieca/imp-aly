import { computed, initState, useState } from 'imp/state'
import { DEFAULT_PRESET, isPreset, presetRange } from './days.js'
import { readStored, writeStored } from './storage.js'

const STORAGE_KEY = 'imp-aly.console.scope'

const SCOPE_STATES = ['aly.scope.servers', 'aly.scope.app', 'aly.scope.period', 'aly.scope.tick']

const isRange = (value) =>
  typeof value?.start === 'string' && typeof value?.end === 'string' && value.start <= value.end

export const periodOf = (value) => {
  if (isPreset(value?.preset)) return { preset: value.preset }
  if (isRange(value)) return { start: value.start, end: value.end }
  return { preset: DEFAULT_PRESET }
}

const rangeOf = (period) => (period.preset ? presetRange(period.preset) : period)

const readSaved = () => {
  const value = readStored(STORAGE_KEY, {})
  return value && typeof value === 'object' ? value : {}
}

export const initScope = (self) => {
  const saved = readSaved()
  const servers = initState(
    self,
    'aly.scope.servers',
    Array.isArray(saved.servers) ? saved.servers.filter((name) => typeof name === 'string') : [],
  )
  const app = initState(
    self,
    'aly.scope.app',
    typeof saved.app === 'string' ? saved.app : undefined,
  )
  const period = initState(self, 'aly.scope.period', periodOf(saved.period))
  initState(self, 'aly.scope.tick', 0)
  period.watch(self, (value) => {
    const clean = periodOf(value)
    if (JSON.stringify(clean) !== JSON.stringify(value)) period.set(clean)
  })
  const save = () =>
    writeStored(STORAGE_KEY, { servers: servers.get(), app: app.get(), period: period.get() })
  for (const state of [servers, app, period]) state.watch(self, save)
  return { servers, app, period }
}

export const useScope = (self) =>
  computed(
    SCOPE_STATES.map((name) => useState(self, name)),
    (servers, app, period, tick) => {
      const clean = periodOf(period)
      const range = rangeOf(clean)
      return { servers, app, from: range.start, to: range.end, preset: clean.preset, tick }
    },
  )
