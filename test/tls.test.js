import { logger } from '../src/logger.js'
import { startServer } from '../src/server.js'
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
