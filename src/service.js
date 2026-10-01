import { logger } from './logger.js'

export const SERVICE_NAME = 'imp-analytics-server'

export const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`

export const SERVICE_ENV = 'IMP_ANALYTICS_SERVICE'

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

export const unitFile = ({ args, home }) =>
  `[Unit]
Description=imp analytics server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[...selfCommand(), ...args].map(quote).join(' ')}
Restart=always
RestartSec=3
LimitNOFILE=65536
Environment=HOME=${quote(home)}
Environment=${SERVICE_ENV}=1

[Install]
WantedBy=multi-user.target
`

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
  const wanted = unitFile(options)
  const current = await readUnit()
  let state
  if (current === wanted) {
    if (await isActive()) return 'running'
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
  logger.info(`The service ${SERVICE_NAME} is removed. The data folder and the key file stay.`)
}
