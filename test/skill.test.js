import { findSkillRoot, installSkill, skillContent } from '../src/commands/skill.js'
import { assert, assertEquals, assertRejects } from './assert.js'

const tree = async (folders, files = []) => {
  const root = await Deno.makeTempDir()
  for (const folder of folders) await Deno.mkdir(`${root}/${folder}`, { recursive: true })
  for (const file of files) await Deno.writeTextFile(`${root}/${file}`, '# notes\n')
  return root
}

Deno.test('in a git repository the skill goes to the git root', async () => {
  const root = await tree(['home/repo/.git', 'home/repo/packages/app/src'], [
    'home/repo/packages/app/AGENTS.md',
  ])
  const home = `${root}/home`
  try {
    assertEquals(findSkillRoot(`${home}/repo/packages/app/src`, home), {
      dir: `${home}/repo`,
      reason: 'git root',
      global: false,
    })
    assertEquals(findSkillRoot(`${home}/repo/packages`, home), {
      dir: `${home}/repo`,
      reason: 'git root',
      global: false,
    })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('outside a git repository the skill goes to the home folder', async () => {
  const root = await tree(['.git', 'home/notes', 'other'], ['home/notes/CLAUDE.md'])
  const home = `${root}/home`
  try {
    const expected = { dir: home, reason: 'not in a git repository', global: true }
    assertEquals(findSkillRoot(`${home}/notes`, home), expected)
    assertEquals(findSkillRoot(home, home), expected)
    assertEquals(findSkillRoot(`${root}/other`, home).dir, root)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('the skill is written for each agent and not replaced', async () => {
  const root = await tree([])
  try {
    const files = await installSkill({ dir: root })
    assertEquals(files.map(({ path }) => path), [
      '.agents/skills/imp-aly/SKILL.md',
      '.claude/skills/imp-aly/SKILL.md',
    ])
    for (const { path } of files) {
      assertEquals(await Deno.readTextFile(`${root}/${path}`), skillContent)
    }
    assert(skillContent.startsWith('---\nname: imp-aly\n'))
    await Deno.remove(`${root}/.agents/skills/imp-aly/SKILL.md`)
    await assertRejects(
      () => installSkill({ dir: root }),
      /claude\/skills\/imp-aly\/SKILL.md exists/,
    )
    await assertRejects(() => Deno.stat(`${root}/.agents/skills/imp-aly/SKILL.md`))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
