import { parseArgs } from './args.js'
import { handOverKey, KEY_LOADED_FILE, removeFile } from './auth.js'
import { logger } from './logger.js'
import { formatHost } from './net.js'
import { dirname, join } from './paths.js'

export const SERVICE_NAME = 'imp-aly'

export const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`

export const SERVICE_ENV = 'IMP_ALY_SERVICE'

export const SERVICE_USER = 'imp-aly'

export const SERVICE_DATA_DIR = '/var/lib/imp-aly'

export const KEY_HANDOVER_DIR = '/run/imp-aly'

export const UPDATE_NAME = 'imp-aly-update'

export const UPDATE_SERVICE_PATH = `/etc/systemd/system/${UPDATE_NAME}.service`

export const UPDATE_TIMER_PATH = `/etc/systemd/system/${UPDATE_NAME}.timer`

export const CREDENTIALS = { key: 'key', tlsCert: 'tls-cert', tlsKey: 'tls-key' }

const HOME_PREFIXES = ['/root/', '/home/', '/run/user/']

const PRIVILEGED_PORTS = 1024

const START_TIMEOUT_MS = 5_000

const HEALTH_MS = 15_000

const HEALTH_POLL_MS = 500

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

export const isCompiled = () => !/(^|\/)deno$/.test(Deno.execPath())

export const selfCommand = () => {
  const executable = Deno.execPath()
  if (isCompiled()) return [executable]
  return [executable, 'run', '--allow-all', Deno.mainModule]
}

export const quote = (argument) => {
  const escaped = argument.replace(/%/g, '%%').replace(/\$/g, '$$$$')
  if (/^[A-Za-z0-9_@%$+=:,./-]+$/.test(escaped)) return escaped
  return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export const unquote = (value) => {
  const inner = value.length > 1 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/\\(.)/g, '$1')
    : value
  return inner.replace(/\$\$/g, '$').replace(/%%/g, '%')
}

const unitValue = (unit, prefix) => {
  const line = unit.split('\n').find((entry) => entry.startsWith(prefix))
  return line === undefined ? null : unquote(line.slice(prefix.length))
}

export const unitSettings = (unit) => {
  const keyPath = unitValue(unit, `LoadCredential=${CREDENTIALS.key}:`)
  const dataDir = unitValue(unit, 'ReadWritePaths=')
  if (!keyPath || !dataDir) {
    throw new Error(
      `${UNIT_PATH} has no key file or no data folder - run sudo imp-aly server again`,
    )
  }
  return { keyPath, dataDir }
}

const UNIT_ARGUMENT = /"(?:\\.|[^"\\])*"|\S+/g

const EXEC_START = 'ExecStart='

const execArguments = (unit) => {
  const line = unit.split('\n').find((entry) => entry.startsWith(EXEC_START))
  return line ? (line.slice(EXEC_START.length).match(UNIT_ARGUMENT) ?? []).map(unquote) : null
}

const WILDCARD_HOSTS = { '0.0.0.0': '127.0.0.1', '::': '::1' }

export const serviceTarget = (unit) => {
  if (!unit) return null
  const command = execArguments(unit)
  const start = command?.indexOf('server') ?? -1
  if (start < 1) return null
  const { flags } = parseArgs(command.slice(start + 1))
  const { keyPath } = unitSettings(unit)
  if (!flags.adminPort) return null
  const bound = flags.adminBind ?? flags.bind ?? '127.0.0.1'
  const host = formatHost(WILDCARD_HOSTS[bound] ?? bound)
  const scheme = flags.tlsCert ? 'https' : 'http'
  return { url: `${scheme}://${host}:${flags.adminPort}`, keyPath }
}

const readUnitSync = () => {
  try {
    return Deno.readTextFileSync(UNIT_PATH)
  } catch {
    return null
  }
}

export const localService = () => serviceTarget(readUnitSync())

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
ProtectProc=invisible
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=true
RemoveIPC=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=${capabilities}
AmbientCapabilities=${capabilities}

[Install]
WantedBy=multi-user.target
`
}

export const updateServiceFile = () => {
  const command = selfCommand()
  return `[Unit]
Description=imp-aly automatic update in the same major version
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${[...command, 'update', '--auto'].map(quote).join(' ')}
StateDirectory=${UPDATE_NAME}
ReadWritePaths=${quote(dirname(command[0]))}
ProtectSystem=strict
ProtectHome=true
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
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_FOWNER
`
}

export const updateTimerFile = () =>
  `[Unit]
Description=Daily check for a new imp-aly version

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
`

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

const idOf = (flag) => {
  const { code, stdout } = new Deno.Command('id', { args: [flag, SERVICE_USER], stdout: 'piped' })
    .outputSync()
  const id = Number(new TextDecoder().decode(stdout).trim())
  if (code !== 0 || !Number.isInteger(id)) throw new Error(`the user ${SERVICE_USER} is missing`)
  return id
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

const readText = async (path) => {
  try {
    return await Deno.readTextFile(path)
  } catch {
    return null
  }
}

export const readUnit = () => readText(UNIT_PATH)

export const isServiceInstalled = async () => (await readUnit()) !== null

const syncFile = async (path, wanted) => {
  const current = await readText(path)
  if (current === wanted) return false
  if (wanted === null) {
    await Deno.remove(path)
    logger.info(`Removed ${path}`)
  } else {
    await Deno.writeTextFile(path, wanted, { mode: 0o644 })
    logger.info(`${current ? 'Updated' : 'Wrote'} ${path}`)
  }
  return true
}

const ensureUpdateTimer = async (enabled) => {
  const timer = `${UPDATE_NAME}.timer`
  if (!enabled && (await readText(UPDATE_TIMER_PATH)) !== null) {
    await runSystemctl('disable', '--now', timer)
  }
  const changed = [
    await syncFile(UPDATE_SERVICE_PATH, enabled ? updateServiceFile() : null),
    await syncFile(UPDATE_TIMER_PATH, enabled ? updateTimerFile() : null),
  ].some(Boolean)
  if (changed) await systemctl('daemon-reload')
  if (enabled) await systemctl('enable', '--now', timer)
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
  const state = await ensureServerUnit(options)
  await ensureUpdateTimer(options.autoUpdate)
  return state
}

const ensureServerUnit = async (options) => {
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

const showService = async () => {
  const { out } = await runSystemctl(
    'show',
    SERVICE_NAME,
    '--property=ActiveState,MainPID,NRestarts',
  )
  return Object.fromEntries(out.split('\n').map((line) => line.split('=')))
}

export const restartService = async () => {
  await systemctl('restart', SERVICE_NAME)
  const first = await showService()
  const start = Date.now()
  while (Date.now() - start < HEALTH_MS) {
    const now = await showService()
    if (
      now.ActiveState !== 'active' || now.MainPID !== first.MainPID ||
      now.NRestarts !== first.NRestarts
    ) {
      return false
    }
    await sleep(HEALTH_POLL_MS)
  }
  return true
}

const KEY_LOAD_MS = 5_000

const lexists = (path) => {
  try {
    Deno.lstatSync(path)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  }
}

export const sendKeyToService = async ({ dataDir, key, handoverDir = KEY_HANDOVER_DIR }) => {
  const loaded = join(dataDir, KEY_LOADED_FILE)
  removeFile(loaded)
  const path = handOverKey({ dir: handoverDir, key, uid: 0, gid: idOf('-g') })
  try {
    await systemctl('kill', '--kill-whom=main', '--signal=SIGHUP', SERVICE_NAME)
    const start = Date.now()
    while (Date.now() - start < KEY_LOAD_MS) {
      if (lexists(loaded)) return true
      await sleep(HEALTH_POLL_MS)
    }
    return false
  } finally {
    removeFile(path)
  }
}

export const uninstallService = async () => {
  await ensureUpdateTimer(false)
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
