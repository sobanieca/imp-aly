import { requireOnlyFlags } from '../args.js'
import { generateKey, readKeyFile, resolveKey, writeKeyFile } from '../auth.js'
import { logger } from '../logger.js'
import { loadServers } from '../servers.js'
import {
  isActive,
  isRoot,
  readUnit,
  sendKeyToService,
  SERVICE_NAME,
  unitSettings,
} from '../service.js'

const USAGE = 'use: imp-aly key rotate [-a <key file>]'

const rotateServiceKey = async ({ unit, key, auth }) => {
  if (!isRoot()) throw new Error('the key of the service changes only as root - use sudo')
  const { keyPath, dataDir } = unitSettings(unit)
  if (auth !== undefined) {
    throw new Error(`the service loads its key from ${keyPath} - run the command without -a`)
  }
  const old = readKeyFile(keyPath)
  writeKeyFile(keyPath, key)
  if (!(await isActive())) {
    logger.info(`The service ${SERVICE_NAME} does not run. It loads the new key when it starts.`)
  } else if (await sendKeyToService({ dataDir, key })) {
    logger.info(
      `The service ${SERVICE_NAME} uses the new key and refuses the old key. It did not stop.`,
    )
  } else {
    throw new Error(
      `the service ${SERVICE_NAME} did not load the new key - check: journalctl -u ${SERVICE_NAME} -n 30, then run: sudo systemctl restart ${SERVICE_NAME}`,
    )
  }
  return { keyPath, old }
}

const rotateKeyFile = ({ key, auth }) => {
  const { path } = resolveKey(auth)
  if (!path) throw new Error('-a takes the path of the key file here, not a key')
  const old = readKeyFile(path)
  if (!old) throw new Error(`the key file ${path} is missing or empty - start the server first`)
  writeKeyFile(path, key)
  logger.info(
    'A server in the foreground loads the new key when you send it SIGHUP (kill -HUP <pid>), or when it starts again.',
  )
  return { keyPath: path, old }
}

const savedWithKey = (key) => {
  try {
    return loadServers().servers.filter((entry) => entry.auth === key)
  } catch {
    return []
  }
}

export const key = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['auth'], 'key')
  const [, action, ...rest] = positional
  if (action !== 'rotate' || rest.length) throw new Error(USAGE)
  const fresh = generateKey()
  const unit = await readUnit()
  const { keyPath, old } = unit === null
    ? rotateKeyFile({ key: fresh, auth: flags.auth })
    : await rotateServiceKey({ unit, key: fresh, auth: flags.auth })
  for (const entry of savedWithKey(old)) {
    logger.warn(
      `The saved server "${entry.name}" holds the old key - run: imp-aly add ${entry.name} ${entry.url} -a ${keyPath}`,
    )
  }
  logger.plain(`
  Key:       ${fresh}
  Key file:  ${keyPath}

Give the new key to each machine that calls this server:

  imp-aly add <name> <admin address> -a <key file>

In the console, open Servers and use "Change the URL or the key" on this server.
`)
}
