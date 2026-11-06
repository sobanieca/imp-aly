import { expect, test } from 'imp/test'
import { installModeOf, isIos, runsAsApp } from '../src/lib/install.js'

const scopeWith = (modes, nav = {}) => ({
  navigator: nav,
  matchMedia: (query) => ({ matches: modes.some((mode) => query === `(display-mode: ${mode})`) }),
})

test('the console knows when it runs as an installed app', () => {
  expect(runsAsApp(scopeWith(['standalone']))).toEqual(true)
  expect(runsAsApp(scopeWith(['window-controls-overlay']))).toEqual(true)
  expect(runsAsApp(scopeWith([], { standalone: true }))).toEqual(true)
  expect(runsAsApp(scopeWith(['browser']))).toEqual(false)
  expect(runsAsApp({ navigator: {} })).toEqual(false)
})

test('the install button shows only when the browser can install the page', () => {
  const base = { installed: false, prompt: true, app: false, secure: true, ios: false }
  expect(installModeOf(base)).toEqual('prompt')
  expect(installModeOf({ ...base, app: true })).toEqual('none')
  expect(installModeOf({ ...base, installed: true })).toEqual('none')
  expect(installModeOf({ ...base, secure: false })).toEqual('none')
  expect(installModeOf({ ...base, prompt: false })).toEqual('none')
  expect(installModeOf({ ...base, prompt: false, ios: true })).toEqual('manual')
  expect(installModeOf({ ...base, prompt: false, ios: true, app: true })).toEqual('none')
})

test('an iPhone and an iPad with a desktop user agent count as iOS', () => {
  expect(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toEqual(
    true,
  )
  expect(
    isIos({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }),
  ).toEqual(true)
  expect(
    isIos({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }),
  ).toEqual(false)
  expect(isIos(undefined)).toEqual(false)
})
