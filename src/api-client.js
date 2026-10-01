import { createToken, findKey } from './auth.js'
import { DEFAULT_PORT } from './server.js'

export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`

export const callApi = async ({ url = DEFAULT_URL, auth, method, path, body }) => {
  const key = findKey(auth)
  const headers = { authorization: `Bearer ${await createToken(key)}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(`cannot reach ${url} - is the server running? (${error.message})`)
  }
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { error: text.trim() }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} answered ${response.status}: ${data.error ?? text}`)
  }
  return data
}
