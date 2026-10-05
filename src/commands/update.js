import { requireOnlyFlags } from '../args.js'
import { DATA_FORMAT } from '../data-format.js'
import { logger } from '../logger.js'
import {
  isActive,
  isCompiled,
  isServiceInstalled,
  restartService,
  SERVICE_NAME,
} from '../service.js'
import {
  addSkipped,
  fetchVersions,
  lockUpdates,
  pickUpdate,
  readSkipped,
  RELEASES_URL,
  restorePrevious,
  stageBinary,
  stateDir,
  swapBinary,
} from '../update.js'
import { version } from '../version.js'

const newestNote = (choice) =>
  choice.newest && choice.newest !== choice.target
    ? `imp-aly ${choice.newest} is out. It can change the data or the commands, so update does not install it. Read ${RELEASES_URL}, then run the install script.`
    : ''

const printCheck = (choice, dir) => {
  logger.plain(`Installed: ${version}`)
  logger.plain(`Update:    ${choice.target ?? 'none'}`)
  if (choice.skipped.length) {
    logger.plain(
      `Skipped:   ${
        choice.skipped.join(', ')
      } (did not stay running here, listed in ${dir}/skipped.json)`,
    )
  }
  const note = newestNote(choice)
  if (note) logger.plain(note)
}

const installTarget = async ({ binary, target, dir }) => {
  logger.info(`Downloading imp-aly ${target}`)
  const staged = await stageBinary({ binary, version: target })
  const previous = await swapBinary(binary, staged)
  logger.info(`Installed imp-aly ${target} in ${binary}. The old binary is ${previous}`)
  if (!(await isServiceInstalled()) || !(await isActive())) {
    logger.info('Restart the server to run the new version')
    return
  }
  logger.info(`Restarting the service ${SERVICE_NAME}`)
  if (await restartService()) {
    logger.info(`The service ${SERVICE_NAME} runs imp-aly ${target}`)
    return
  }
  await restorePrevious(binary)
  await addSkipped(dir, target)
  const back = await restartService()
  throw new Error(
    `imp-aly ${target} did not stay running, so imp-aly ${version} is back${
      back ? '' : ', but it did not stay running either'
    } - check: journalctl -u ${SERVICE_NAME} -n 50`,
  )
}

export const update = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['check'], 'update')
  if (positional.length > 1) throw new Error('use: imp-aly update [--check]')
  if (!isCompiled()) {
    throw new Error('update replaces the imp-aly binary - this imp-aly runs from source with deno')
  }
  const binary = Deno.execPath()
  const dir = stateDir()
  const choice = pickUpdate({
    current: version,
    format: DATA_FORMAT,
    versions: await fetchVersions(),
    skipped: await readSkipped(dir),
  })
  if (flags.check) return printCheck(choice, dir)
  const note = newestNote(choice)
  if (note) logger.info(note)
  if (!choice.target) {
    logger.info(`imp-aly ${version} is the newest compatible version`)
    return
  }
  const lock = await lockUpdates(dir)
  try {
    await installTarget({ binary, target: choice.target, dir })
  } finally {
    lock.close()
  }
}
