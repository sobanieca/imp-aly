# The agent skill goes to the git repository, or else to the home folder

## Context

AI agents such as Claude Code, Codex and Cursor read skills from `SKILL.md` files. A skill lets the
user ask an agent for numbers with `/imp-aly`. The agents read skills from a project folder and from
the home folder. jsonr and sqlr create their skills with `skill --init`, and imp-aly does the same.
A user who runs the command outside a project wants the skill in all projects.

## Decision

**`imp-aly skill --init` writes the skill into the git repository of the current folder. Outside a
git repository, it writes the skill into the home folder.**

- The command looks for `.git` in the current folder and in each parent folder. It stops at the home
  folder, or at the root of the file system when the current folder is outside the home folder.
- In a git repository, the skill goes to the git root, also when the command runs in a subfolder.
  One skill serves all folders of the repository. An agent session in a package of a monorepo also
  finds it.
- The command writes the same file to `.agents/skills/imp-aly/SKILL.md` and
  `.claude/skills/imp-aly/SKILL.md`. Codex reads the first folder, Claude Code reads the second, and
  Cursor reads both.
- The command does not replace a skill that exists. It checks both files before it writes one.

## Consequences

- One rule: one skill per repository, or one skill in the home folder. There is no skill per
  package.
- A `.git` folder above the home folder does not count. So a home folder inside a repository still
  gets the skill.
- The skill text is in the binary. To get a newer text, remove the files and run the command again.
