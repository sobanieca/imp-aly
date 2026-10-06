import { expect, test } from 'imp/test'
import { hashBody, signedPath } from '../src/lib/client.js'
import { parseServerUrl } from '../src/lib/vault.js'

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

test('the body hash covers no body, a text and a file', async () => {
  expect(await hashBody(null)).toEqual(EMPTY)
  expect(await hashBody('abc')).toEqual(ABC)
  expect(await hashBody(new Blob(['a', 'bc']))).toEqual(ABC)
})

test('the signed path leaves out the path of the server URL and keeps the query', () => {
  expect(signedPath('https://a.example:2981/query', 'https://a.example:2981')).toEqual('/query')
  expect(signedPath('https://a.example/aly/backup?app=shop', 'https://a.example/aly')).toEqual(
    '/backup?app=shop',
  )
})

test('a server URL is http or https, and an https page calls only https', () => {
  expect(parseServerUrl('https://a.example:2981/', 'https:')).toEqual('https://a.example:2981')
  expect(parseServerUrl('http://127.0.0.1:2981', 'https:')).toEqual('http://127.0.0.1:2981')
  expect(parseServerUrl('http://a.example:2981', 'http:')).toEqual('http://a.example:2981')
  expect(() => parseServerUrl('http://a.example:2981', 'https:')).toThrow(/https/)
  expect(() => parseServerUrl('ftp://a.example', 'http:')).toThrow(/not a server URL/)
  expect(() => parseServerUrl('https://a.example/?x=1', 'http:')).toThrow(/query/)
})
