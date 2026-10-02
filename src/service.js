import { logger } from './logger.js'
import { dirname, join } from './paths.js'

export const SERVICE_NAME = 'imp-aly'

export const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`

export const SERVICE_ENV = 'IMP_ALY_SERVICE'

export const SERVICE_USER = 'imp-aly'

export const SERVICE_DATA_DIR = '/var/lib/imp-aly'

export const CREDENTIALS = { key: 'key', tlsCert: 'tls-cert', tlsKey: 'tls-key' }

const HOME_PREFIXES = ['/root/', '/home/', '/run/user/']

const PRIVILEGED_PORTS = 1024

const START_TIMEOUT_MS = 5_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const runSystemctl = async (...args) => {
  try {
    const { code, stdout, stderr } = await new Deno.Command('systemctl', {
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const decoder = new TextDecoder()
    return { code, out: decoder.decode(stdout).trim(), err: decoder.decode(stderr).trim() }
  } catch (error) {
    return { code: -1, out: '', err: error.message }
  }
}

const systemctl = async (...args) => {
  const result = await runSystemctl(...args)
  if (result.code !== 0) throw new Error(`systemctl ${args.join(' ')} failed: ${result.err}`)
  return result.out
}

export const isInsideService = () => Deno.env.get(SERVICE_ENV) === '1'

export const credentialPath = (name) => {
  const dir = Deno.env.get('CREDENTIALS_DIRECTORY')
  if (!dir) {
    throw new Error(
      'the service has no credentials - run sudo imp-aly server again to update the unit file',
    )
  }
  return join(dir, name)
}

const isUnderHome = (path) => HOME_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix))

export const isRoot = () => Deno.uid() === 0

export const hasSystemd = () => {
  try {
    return Deno.statSync('/run/systemd/system').isDirectory
  } catch {
    return false
  }
}

export const serviceBlocker = () => {
  if (Deno.build.os !== 'linux') return 'not on Linux'
  if (!hasSystemd()) return 'systemd not found'
  if (!isRoot()) return 'not running as root (try sudo)'
  return ''
}

export const selfCommand = () => {
  const executable = Deno.execPath()
  if (!/(^|\/)deno$/.test(executable)) return [executable]
  return [executable, 'run', '--allow-all', Deno.mainModule]
}

export const quote = (argument) => {
  const escaped = argument.replace(/%/g, '%%').replace(/\$/g, '$$$$')
  if (/^[A-Za-z0-9_@%$+=:,./-]+$/.test(escaped)) return escaped
  return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export const unitFile = ({ args, dataDir, ports, keyPath, tlsCert = null, tlsKey = null }) => {
  const capabilities = ports.some((port) => port < PRIVILEGED_PORTS) ? 'CAP_NET_BIND_SERVICE' : ''
  const credentials = [
    `LoadCredential=${CREDENTIALS.key}:${quote(keyPath)}`,
    ...(tlsCert && tlsKey
      ? [
        `LoadCredential=${CREDENTIALS.tlsCert}:${quote(tlsCert)}`,
        `LoadCredential=${CREDENTIALS.tlsKey}:${quote(tlsKey)}`,
      ]
      : []),
  ]
  return `[Unit]
Description=imp-aly analytics server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[...selfCommand(), ...args].map(quote).join(' ')}
User=${SERVICE_USER}
Group=${SERVICE_USER}
Restart=always
RestartSec=3
LimitNOFILE=65536
Environment=${SERVICE_ENV}=1
${credentials.join('\n')}
UMask=0077
ReadWritePaths=${quote(dataDir)}
ProtectSystem=strict
ProtectHome=${isUnderHome(dataDir) ? 'read-only' : 'true'}
PrivateTmp=true
PrivateDevices=true
NoNewPrivileges=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=${capabilities}
AmbientCapabilities=${capabilities}

[Install]
WantedBy=multi-user.target
`
}

const run = async (command, args) => {
  try {
    const { code, stderr } = await new Deno.Command(command, {
      args,
      stdout: 'null',
      stderr: 'piped',
    }).output()
    return { code, err: new TextDecoder().decode(stderr).trim() }
  } catch (error) {
    return { code: -1, err: error.message }
  }
}

const mustRun = async (command, args) => {
  const result = await run(command, args)
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.err || `code ${result.code}`}`)
  }
}

const nologinShell = () =>
  ['/usr/sbin/nologin', '/sbin/nologin'].find((path) => {
    try {
      return Deno.statSync(path).isFile
    } catch {
      return false
    }
  }) ?? '/bin/false'

export const serviceProblems = ({ dataDir, keyPath, tlsCert, tlsKey }) => {
  const problems = []
  for (const path of [keyPath, tlsCert, tlsKey]) {
    if (path && quote(path) !== path) {
      problems.push(`the service cannot load ${path} - use a path of letters, digits and "/._-"`)
    }
  }
  if (dataDir.startsWith('/root/') || dataDir === '/root') {
    problems.push(
      `the service user cannot reach ${dataDir} - use a folder outside /root, like ${SERVICE_DATA_DIR}`,
    )
  }
  for (const path of selfCommand()) {
    if (isUnderHome(path)) {
      problems.push(
        `the service cannot run ${path}, because the service hides /root and /home - install imp-aly in /usr/local/bin`,
      )
    }
  }
  return problems
}

const ensureUser = async () => {
  if ((await run('id', ['-u', SERVICE_USER])).code === 0) return
  await mustRun('useradd', [
    '--system',
    '--user-group',
    '--no-create-home',
    '--home-dir',
    '/nonexistent',
    '--shell',
    nologinShell(),
    SERVICE_USER,
  ])
  logger.info(`Created the system user ${SERVICE_USER}`)
}

const exists = async (path) => {
  try {
    await Deno.stat(path)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  }
}

const firstMissingFolder = async (path) => {
  let missing = null
  for (let current = path; !(await exists(current)); current = dirname(current)) {
    missing = current
  }
  return missing
}

const serviceUserCan = async (test, path) =>
  (await run('runuser', ['-u', SERVICE_USER, '--', 'test', test, path])).code !== 1

const cannotWrite = (dataDir) =>
  new Error(
    `the user ${SERVICE_USER} cannot write ${dataDir} - give it access to the parent folders, or use ${SERVICE_DATA_DIR}`,
  )

const prepareDataDir = async (dataDir) => {
  const created = await firstMissingFolder(dataDir)
  if (!(await serviceUserCan('-x', dirname(created ?? dataDir)))) throw cannotWrite(dataDir)
  await Deno.mkdir(dataDir, { recursive: true })
  try {
    await mustRun('chown', ['-R', `${SERVICE_USER}:${SERVICE_USER}`, dataDir])
    await Deno.chmod(dataDir, 0o700)
    if (!(await serviceUserCan('-w', dataDir))) throw cannotWrite(dataDir)
  } catch (error) {
    if (created) await Deno.remove(created, { recursive: true })
    throw error
  }
}

const readUnit = async () => {
  try {
    return await Deno.readTextFile(UNIT_PATH)
  } catch {
    return null
  }
}

export const isActive = async () => (await runSystemctl('is-active', SERVICE_NAME)).out === 'active'

const waitUntilActive = async () => {
  const start = Date.now()
  while (Date.now() - start < START_TIMEOUT_MS) {
    if (await isActive()) {
      await sleep(1_000)
      if (await isActive()) return true
    }
    await sleep(200)
  }
  return false
}

export const ensureService = async (options) => {
  const problems = serviceProblems(options)
  if (problems.length) throw new Error(problems.join('\n'))
  const wanted = unitFile(options)
  const current = await readUnit()
  if (current === wanted && (await isActive())) return 'running'
  await ensureUser()
  await prepareDataDir(options.dataDir)
  let state
  if (current === wanted) {
    await systemctl('enable', '--now', SERVICE_NAME)
    state = 'started'
  } else {
    await Deno.writeTextFile(UNIT_PATH, wanted, { mode: 0o644 })
    logger.info(`${current ? 'Updated' : 'Wrote'} ${UNIT_PATH}`)
    await systemctl('daemon-reload')
    await systemctl('enable', SERVICE_NAME)
    await systemctl('restart', SERVICE_NAME)
    state = current ? 'updated' : 'installed'
  }
  if (!(await waitUntilActive())) {
    throw new Error(
      `the service ${SERVICE_NAME} did not start - check: journalctl -u ${SERVICE_NAME} -n 30`,
    )
  }
  return state
}

export const uninstallService = async () => {
  const result = await runSystemctl('disable', '--now', SERVICE_NAME)
  if (result.code !== 0) logger.warn(result.err)
  try {
    await Deno.remove(UNIT_PATH)
    logger.info(`Removed ${UNIT_PATH}`)
  } catch {
    logger.warn(`${UNIT_PATH} was not found`)
  }
  await systemctl('daemon-reload')
  logger.info(
    `The service ${SERVICE_NAME} is removed. The data folder, the key file and the user ${SERVICE_USER} stay.`,
  )
}
