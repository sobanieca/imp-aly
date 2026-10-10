import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
import { sha256Hex } from '../src/sha256.js'
import { createToken } from '../src/token.js'
import { assert, assertEquals, temporaryDir, waitFor } from './assert.js'

const hasOpenssl = (() => {
  try {
    return new Deno.Command('openssl', { args: ['version'], stdout: 'null', stderr: 'null' })
      .outputSync().success
  } catch {
    return false
  }
})()

const makeCertificate = async (dir, name) => {
  const { success } = await new Deno.Command('openssl', {
    args: [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-keyout',
      `${dir}/${name}-key.pem`,
      '-out',
      `${dir}/${name}-cert.pem`,
    ],
    stdout: 'null',
    stderr: 'null',
  }).output()
  assert(success, 'openssl made a certificate')
  return {
    cert: await Deno.readTextFile(`${dir}/${name}-cert.pem`),
    key: await Deno.readTextFile(`${dir}/${name}-key.pem`),
  }
}

const install = async (dir, { cert, key }, at) => {
  await Deno.writeTextFile(`${dir}/cert.pem`, cert)
  await Deno.writeTextFile(`${dir}/key.pem`, key)
  await Deno.utime(`${dir}/cert.pem`, at, at)
  await Deno.utime(`${dir}/key.pem`, at, at)
}

const answers = async (port, cert) => {
  const client = Deno.createHttpClient({ caCerts: [cert] })
  try {
    const response = await fetch(`https://localhost:${port}/`, { client })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  } finally {
    client.close()
  }
}

Deno.test({
  name: 'a changed certificate restarts the listener, and a broken one keeps the old',
  ignore: !hasOpenssl,
  fn: async () => {
    logger.setQuiet(true)
    const dir = await temporaryDir()
    const first = await makeCertificate(dir, 'first')
    const second = await makeCertificate(dir, 'second')
    await install(dir, first, 1_000)
    const server = await startServer({
      port: 0,
      adminPort: 0,
      hostname: '127.0.0.1',
      dataDir: `${dir}/data`,
      key: 'test-key',
      minFree: null,
      quiet: true,
      tlsCert: `${dir}/cert.pem`,
      tlsKey: `${dir}/key.pem`,
      tlsCheckMs: 30,
    })
    try {
      assert(await answers(server.port, first.cert))
      assert(!(await answers(server.port, second.cert)))
      await install(dir, second, 2_000)
      await waitFor(() => answers(server.port, second.cert))
      await install(dir, { cert: 'broken', key: 'broken' }, 3_000)
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert(await answers(server.port, second.cert))
    } finally {
      await server.shutdown()
      await Deno.remove(dir, { recursive: true })
    }
  },
})

Deno.test({
  name: 'a change of the watched files calls the given handler',
  ignore: !hasOpenssl,
  fn: async () => {
    const dir = await temporaryDir()
    const first = await makeCertificate(dir, 'first')
    await install(dir, first, 1_000)
    await Deno.writeTextFile(`${dir}/source.pem`, 'a')
    const changes = []
    const server = await startServer({
      port: 0,
      adminPort: 0,
      hostname: '127.0.0.1',
      dataDir: `${dir}/data`,
      key: 'test-key',
      minFree: null,
      quiet: true,
      tlsCert: `${dir}/cert.pem`,
      tlsKey: `${dir}/key.pem`,
      tlsWatch: [`${dir}/source.pem`],
      tlsCheckMs: 30,
      onTlsChange: () => {
        changes.push(Date.now())
        return true
      },
    })
    try {
      await Deno.writeTextFile(`${dir}/source.pem`, 'bb')
      await waitFor(() => changes.length === 1)
      await new Promise((resolve) => setTimeout(resolve, 100))
      assertEquals(changes.length, 1)
    } finally {
      await server.shutdown()
      await Deno.remove(dir, { recursive: true })
    }
  },
})

const BUILD = JSON.stringify({ pages: ['/'], zones: [], outcomes: [] })

const adminCall = async (server, cert, method, path, body) => {
  const bodyHash = body === undefined ? undefined : sha256Hex(new TextEncoder().encode(body))
  const token = await createToken('test-key', { method, path, ...(bodyHash ? { bodyHash } : {}) })
  const client = Deno.createHttpClient({ caCerts: [cert] })
  try {
    const response = await fetch(`https://localhost:${server.adminPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body,
      client,
    })
    assertEquals(response.status, 200)
    return await response.json()
  } finally {
    client.close()
  }
}

const isRefused = (error) => /Connection refused/.test(String(error?.cause?.message ?? error))

Deno.test({
  name: 'a new certificate starts at once, with no gap, while running requests finish',
  ignore: !hasOpenssl,
  fn: async () => {
    logger.setQuiet(true)
    const dir = await temporaryDir()
    const first = await makeCertificate(dir, 'first')
    const second = await makeCertificate(dir, 'second')
    await install(dir, first, 1_000)
    const server = await startServer({
      port: 0,
      adminPort: 0,
      hostname: '127.0.0.1',
      dataDir: `${dir}/data`,
      key: 'test-key',
      minFree: null,
      quiet: true,
      tlsCert: `${dir}/cert.pem`,
      tlsKey: `${dir}/key.pem`,
      tlsCheckMs: 30,
      collectTimeoutMs: 30_000,
      fetchFile: () => Promise.resolve(BUILD),
    })
    const both = Deno.createHttpClient({ caCerts: [first.cert, second.cert] })
    let polling = true
    let refused = 0
    let answered = 0
    let poll = Promise.resolve()
    let send = null
    let bodyOpen = true
    let slow = Promise.resolve()
    try {
      await adminCall(server, first.cert, 'PUT', '/apps/myapp', JSON.stringify({ build: BUILD }))
      const body = new ReadableStream({ start: (controller) => (send = controller) })
      let finished = false
      slow = fetch(`https://localhost:${server.port}/collect/myapp`, {
        method: 'POST',
        body,
        duplex: 'half',
        client: both,
      }).then((response) => ({ response }), (error) => ({ error }))
        .finally(() => (finished = true))
      await waitFor(async () => {
        const status = await adminCall(server, first.cert, 'GET', '/status')
        return status.activeRequests.public === 1
      })
      poll = (async () => {
        while (polling) {
          const client = Deno.createHttpClient({ caCerts: [first.cert, second.cert] })
          try {
            const response = await fetch(`https://localhost:${server.port}/`, { client })
            await response.body?.cancel()
            if (response.ok) answered++
          } catch (error) {
            if (isRefused(error)) refused++
          } finally {
            client.close()
          }
        }
      })()
      await install(dir, second, 2_000)
      await waitFor(() => answers(server.port, second.cert))
      assert(!(await answers(server.port, first.cert)))
      assert(!finished, 'the running request still runs')
      send.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ type: 'page', visit: 'v1', at: Date.now(), page: '/' }),
        ),
      )
      send.close()
      bodyOpen = false
      const { response, error } = await slow
      assertEquals(error, undefined)
      assertEquals(response.status, 202)
      await response.body?.cancel()
      polling = false
      await poll
      assert(answered > 0)
      assertEquals(refused, 0)
    } finally {
      polling = false
      await poll
      if (bodyOpen) send?.close()
      await slow
      both.close()
      await server.shutdown()
      await Deno.remove(dir, { recursive: true })
    }
  },
})
