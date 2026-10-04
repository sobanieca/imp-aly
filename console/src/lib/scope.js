import { computed, initState, useState } from 'imp/state'
import { presetOf, presetRange, PRESETS } from './days.js'
import { readStored, writeStored } from './storage.js'

const STORAGE_KEY = 'imp-aly.console.scope'

const DEFAULT_PRESET = '30d'

const SCOPE_STATES = ['aly.scope.servers', 'aly.scope.app', 'aly.scope.range', 'aly.scope.tick']

const isRange = (value) =>
  typeof value?.start === 'string' && typeof value?.end === 'string' && value.start <= value.end

const readSaved = () => {
  const value = readStored(STORAGE_KEY, {})
  return value && typeof value === 'object' ? value : {}
}

export const initScope = (self) => {
  const saved = readSaved()
  const knownPreset = PRESETS.some(({ value }) => value === saved.preset) ? saved.preset : undefined
  const preset = knownPreset ?? (isRange(saved.range) ? undefined : DEFAULT_PRESET)
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
  const range = initState(self, 'aly.scope.range', preset ? presetRange(preset) : saved.range)
  const chosen = initState(self, 'aly.scope.preset', preset)
  initState(self, 'aly.scope.tick', 0)
  chosen.watch(self, (value) => {
    if (value) range.set(presetRange(value))
  })
  range.watch(self, (value) => {
    if (!isRange(value)) {
      chosen.set(DEFAULT_PRESET)
      return range.set(presetRange(DEFAULT_PRESET))
    }
    const match = presetOf(value)
    if (match !== chosen.get()) chosen.set(match)
  })
  const save = () =>
    writeStored(STORAGE_KEY, {
      servers: servers.get(),
      app: app.get(),
      preset: chosen.get(),
      range: range.get(),
    })
  for (const state of [servers, app, range, chosen]) state.watch(self, save)
  return { servers, app, range, preset: chosen }
}

export const useScope = (self) =>
  computed(
    SCOPE_STATES.map((name) => useState(self, name)),
    (servers, app, range, tick) => ({ servers, app, from: range?.start, to: range?.end, tick }),
  )
