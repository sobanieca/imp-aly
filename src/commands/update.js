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
  checkInstalled,
  fetchPublishDates,
  fetchVersions,
  isAutoCompatible,
  lockUpdates,
  MIN_RELEASE_AGE_DAYS,
  pickUpdate,
  readSkipped,
  RELEASES_URL,
  restorePrevious,
  stageBinary,
  stateDir,
  swapBinary,
  withPublishDates,
} from '../update.js'
import { version } from '../version.js'

const day = (ms) => new Date(ms).toISOString().slice(0, 10)

const heldNote = ({ version: held, reason, published }, dir) => {
  if (reason === 'format') {
    return `imp-aly ${held} reads another data format, so update does not install it. Read ${RELEASES_URL}.`
  }
  if (reason === 'major') {
    return `imp-aly ${held} can change the data folder, the API or the commands, so the timer does not install it. Read ${RELEASES_URL}, then run: sudo imp-aly update`
  }
  if (reason === 'age') {
    const since = published === null
      ? 'has no publish date on GitHub'
      : `is out since ${day(published)}`
    return `imp-aly ${held} ${since}. The timer installs a version ${MIN_RELEASE_AGE_DAYS} days after GitHub publishes it.`
  }
  return `imp-aly ${held} did not stay running here, so update does not install it. It is in ${dir}/skipped.json.`
}

const heldNotes = (choice, dir) => {
  const seen = new Set()
  return choice.held.filter(({ reason }) => !seen.has(reason) && seen.add(reason))
    .map((entry) => heldNote(entry, dir))
}

const loadVersions = async (auto) => {
  const versions = await fetchVersions()
  return auto ? withPublishDates(versions, await fetchPublishDates()) : versions
}

const choose = ({ versions, skipped, auto }) =>
  pickUpdate({ current: version, format: DATA_FORMAT, versions, skipped, auto })

const printCheck = async (dir) => {
  const versions = await loadVersions(true)
  const skipped = await readSkipped(dir)
  const manual = choose({ versions, skipped, auto: false })
  const timer = choose({ versions, skipped, auto: true })
  logger.plain(`Installed: ${version}`)
  logger.plain(`Update:    ${manual.target ?? 'none'}  (sudo imp-aly update)`)
  logger.plain(`Timer:     ${timer.target ?? 'none'}  (the daily update)`)
  for (const note of heldNotes(timer, dir)) logger.plain(note)
}

const restartChecked = async () => {
  try {
    return await restartService()
  } catch (error) {
    logger.error(error.message)
    return false
  }
}

const installTarget = async ({ binary, target, dir }) => {
  logger.info(`Downloading imp-aly ${target}`)
  const staged = await stageBinary({ binary, version: target })
  const previous = await swapBinary(binary, staged)
  logger.info(`Installed imp-aly ${target} in ${binary}. The old binary is ${previous}`)
  if (!isAutoCompatible(version, target)) {
    logger.info(
      `imp-aly ${target} can change the unit file. Run your sudo imp-aly server command again after the restart.`,
    )
  }
  if (!(await isServiceInstalled()) || !(await isActive())) {
    logger.info('Restart the server to run the new version')
    return
  }
  logger.info(`Restarting the service ${SERVICE_NAME}`)
  if (await restartChecked()) {
    logger.info(`The service ${SERVICE_NAME} runs imp-aly ${target}`)
    return
  }
  await restorePrevious(binary)
  await addSkipped(dir, target)
  const back = await restartChecked()
  throw new Error(
    `imp-aly ${target} did not stay running, so imp-aly ${version} is back${
      back ? '' : ', but it did not stay running either'
    } - check: journalctl -u ${SERVICE_NAME} -n 50`,
  )
}

export const update = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['check', 'auto'], 'update')
  if (positional.length > 1) throw new Error('use: imp-aly update [--check] [--auto]')
  if (!isCompiled()) {
    throw new Error('update replaces the imp-aly binary - this imp-aly runs from source with deno')
  }
  const binary = Deno.execPath()
  const dir = stateDir()
  if (flags.check) return await printCheck(dir)
  const auto = Boolean(flags.auto)
  const lock = await lockUpdates(dir)
  try {
    await checkInstalled(binary, version)
    const choice = choose({
      versions: await loadVersions(auto),
      skipped: await readSkipped(dir),
      auto,
    })
    for (const note of heldNotes(choice, dir)) logger.info(note)
    if (!choice.target) {
      logger.info(`imp-aly ${version} is the newest version that update can install`)
      return
    }
    await installTarget({ binary, target: choice.target, dir })
  } finally {
    lock.close()
  }
}
