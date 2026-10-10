import { mount } from 'imp'
import { setLogLevel } from 'imp/log'
import { button } from 'imp/std'
import { form, submitForm, textField } from 'imp/std/inputs'
import { beforeEach, expect, test } from 'imp/test'
import { keyField } from '../src/parts/key-field.js'

const KEY = 'k3yThatMustNotLeakIntoAnyLog0123'

const logged = []

const capture = () => {
  const original = console.log
  console.log = (...args) => {
    logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    original(...args)
  }
  return () => (console.log = original)
}

const type = (host, value) => {
  const input = host.shadowRoot.querySelector('input')
  input.value = value
  input.dispatchEvent(new Event('input'))
}

const submitted = (key) => {
  let resolve
  const done = new Promise((ready) => (resolve = ready))
  const nameField = textField({ field: 'name', label: 'Name' })
  const send = button({ events: { click: submitForm } }, 'Save')
  const root = form(
    { initialValues: { name: '' }, onSubmit: (values) => resolve(values) },
    nameField,
    key,
    send,
  )
  mount(document.body, () => root)
  type(nameField, 'eu-1')
  type(key, KEY)
  send.shadowRoot.querySelector('button').click()
  return done
}

const traced = async (run) => {
  setLogLevel('debug')
  const restore = capture()
  try {
    return await run()
  } finally {
    restore()
    setLogLevel('info')
  }
}

beforeEach(() => {
  logged.length = 0
  document.body.replaceChildren()
})

test('the key goes to onSubmit, never to the debug log, and the field clears after the save', async () => {
  const key = keyField({ editing: false })
  const values = await traced(() => submitted(key))
  await Promise.resolve()
  expect(values).toEqual({ name: 'eu-1', key: KEY })
  expect(key.shadowRoot.querySelector('input').value).toEqual('')
  expect(logged.some((line) => line.includes('eu-1'))).toEqual(true)
  expect(logged.some((line) => line.includes(KEY))).toEqual(false)
})

test('a key in a plain form field shows in the debug log of the state', async () => {
  const values = await traced(() =>
    submitted(textField({ field: 'key', label: 'Key', type: 'password' }))
  )
  expect(values.key).toEqual(KEY)
  expect(logged.some((line) => line.includes(KEY))).toEqual(true)
})

test('the key is necessary for a new server and can stay empty for a change', () => {
  const fresh = keyField({ editing: false })
  const change = keyField({ editing: true })
  mount(document.body, () => form({ initialValues: {} }, fresh, change))
  expect(fresh.shadowRoot.querySelector('input').getAttribute('aria-required')).toEqual('true')
  expect(change.shadowRoot.querySelector('input').hasAttribute('aria-required')).toEqual(false)
})
