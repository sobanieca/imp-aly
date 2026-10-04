import { requireOnlyFlags } from '../args.js'
import { logger } from '../logger.js'
import { dirname, getHome, join } from '../paths.js'
import { helpText } from './help.js'

const SKILL_NAME = 'imp-aly'
const SKILL_TARGETS = [
  { dir: '.agents/skills', readBy: 'Codex, Cursor' },
  { dir: '.claude/skills', readBy: 'Claude Code, Cursor' },
]

export const skillContent = `---
name: ${SKILL_NAME}
description: Query the analytics of imp apps and check imp-aly servers with the imp-aly CLI. Use when asked about visits, page views, zones, outcomes, errors or other analytics numbers of an imp app, or about the registered apps and the state of an imp-aly server.
---

# imp-aly

\`imp-aly\` collects the analytics records of imp apps on a VPS and answers
queries. The client commands call saved servers by name. The keys stay in the
files of the user. Never ask for a key and never put a key in a command.

## Workflow

1. Run \`imp-aly skill\` once to read the full reference (commands, options and
   the API).
2. Run \`imp-aly ls\` to see the saved servers. \`*\` marks the default server.
   Use \`-s <name>\` for another server, or \`-s eu,us\` to add up the answers of
   several servers.
3. Run \`imp-aly app ls\` to see the registered apps. Run
   \`imp-aly app show <name>\` to see the segments and the rejection counts of
   one app.
4. Query with a JSON object:
   \`imp-aly query '{"app": "myapp", "from": "2026-09-01", "to": "2026-09-30", "groupBy": ["page"], "measures": ["records", "visits"]}'\`.
   Add \`--json\` to get the answer as JSON.
5. Run \`imp-aly status\` to see the state of a server: the version, the apps,
   the storage and the free disk space.

## Queries

- Fields: \`app\` (required), \`from\` and \`to\` (\`YYYY-MM-DD\`, UTC), \`where\`,
  \`groupBy\`, \`measures\`, \`limit\`.
- Dimensions: \`type\`, \`visit\`, \`page\`, \`zone\`, \`name\`, \`country\` and the
  segments of the app. \`day\`, \`week\` and \`month\` are for \`groupBy\`
  only, one of them per query.
- \`where\` maps a dimension to a value, to null, or to a list of them.
- Measures: \`records\` and \`visits\`.
- Types: \`page\` (a page view), \`seen\` and \`used\` (at most one per zone per
  page view), \`outcome\`, \`error\`. The share of a zone that people use when
  they see it is \`used\` / \`seen\` records.
- Do not count \`visits\` with \`zone\` or \`name\`: such a query reads every
  record and is slow.
- Before you report numbers, check \`skippedDays\` and \`failedServers\` in the
  \`--json\` answer.

## Rules

- Ask before \`app add\`, \`app rm\`, \`restore\` or another command that changes
  a server.
- Do not run \`imp-aly server\` unless the user asks for it. As root, it installs
  a systemd service.
- Use \`imp-aly token\` only when the user asks for a raw call to the API.
`

const agentInstructions = `
imp-aly - instructions for AI agents

  Run 'imp-aly skill --init' to create a skill, then invoke it with
  /imp-aly (Claude Code, Cursor) or $imp-aly (Codex). In a git repository,
  the command writes the skill into the repository. Outside a git
  repository, it writes the skill into the home folder.

  The keys of the servers stay in the files of the user. Never ask for a
  key and never put a key in a command. Use a saved server: -s <name>.

  The full reference follows.`

const exists = (path) => {
  try {
    Deno.statSync(path)
    return true
  } catch {
    return false
  }
}

export const findSkillRoot = (start = Deno.cwd(), home = getHome()) => {
  let dir = start
  while (true) {
    if (exists(join(dir, '.git'))) return { dir, reason: 'git root', global: false }
    const parent = dirname(dir)
    if (dir === home || parent === dir) break
    dir = parent
  }
  return { dir: home, reason: 'not in a git repository', global: true }
}

export const installSkill = async (root) => {
  const files = SKILL_TARGETS.map((target) => ({
    ...target,
    path: join(target.dir, SKILL_NAME, 'SKILL.md'),
  }))
  for (const { path } of files) {
    const file = join(root.dir, path)
    if (exists(file)) throw new Error(`${file} exists - remove it to write the skill again`)
  }
  for (const { path } of files) {
    const file = join(root.dir, path)
    await Deno.mkdir(dirname(file), { recursive: true })
    await Deno.writeTextFile(file, skillContent)
  }
  return files
}

export const skill = async ({ positional, flags }) => {
  requireOnlyFlags(flags, ['init'], 'skill')
  if (positional.length > 1) throw new Error('use: imp-aly skill [--init]')
  if (!flags.init) {
    console.log(agentInstructions)
    console.log(helpText())
    return
  }
  const root = findSkillRoot()
  const files = await installSkill(root)
  logger.plain(
    root.global
      ? `Not in a git repository - the skill is for all projects, in ${root.dir}`
      : `Project root: ${root.dir} (${root.reason})`,
  )
  for (const { path, readBy } of files) logger.plain(`Created ${path}  (${readBy})`)
  logger.plain('')
  logger.plain('Try: /imp-aly how many visits did myapp have last week, per page')
}
