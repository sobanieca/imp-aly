use super::help::help_text;
use crate::args::{Parsed, require_only_flags};
use crate::error::{Error, Result};
use crate::logger;
use crate::paths::{cwd, dirname, home, join};
use std::fs;

const SKILL_NAME: &str = "imp-aly";

const SKILL_TARGETS: [(&str, &str); 2] = [
    (".agents/skills", "Codex, Cursor"),
    (".claude/skills", "Claude Code, Cursor"),
];

pub const SKILL_CONTENT: &str = r#"---
name: imp-aly
description: Query the analytics of imp apps and check imp-aly servers with the imp-aly CLI. Use when asked about visits, page views, zones, outcomes, errors or other analytics numbers of an imp app, or about the registered apps and the state of an imp-aly server.
---

# imp-aly

`imp-aly` collects the analytics records of imp apps on a VPS and answers
queries. The client commands call saved servers by name. The keys stay in the
files of the user. Never ask for a key and never put a key in a command.

## Workflow

1. Run `imp-aly skill` once to read the full reference (commands, options and
   the API).
2. Run `imp-aly ls` to see the saved servers and groups. `*` marks the
   default. Use `-s <name>` for another server, or `-s eu,us` or a group to
   add up the answers of several servers.
3. Run `imp-aly app ls` to see the registered apps. Run
   `imp-aly app show <name>` to see the pages, the zones, the outcome names,
   the segments and the rejection counts of one app. Use these values in
   `where`.
4. Query with a JSON object:
   `imp-aly query '{"app": "myapp", "from": "2026-09-01", "to": "2026-09-30", "groupBy": ["page"], "measures": ["records", "visits"]}'`.
   Add `--json` to get the answer as JSON.
5. Run `imp-aly status` to see the state of a server: the version, the apps,
   the storage and the free disk space.

## Queries

- Fields: `app` (required), `from` and `to` (`YYYY-MM-DD`, UTC), `where`,
  `groupBy`, `measures`, `limit`.
- Dimensions: `type`, `visit`, `page`, `zone`, `name`, `country` and the
  segments of the app. `day`, `week` and `month` are for `groupBy`
  only, one of them per query.
- `where` maps a dimension to a value, to null, or to a list of them.
- Measures: `records` and `visits`.
- Types: `page` (a page view), `seen` and `used` (at most one per zone per
  page view), `outcome`, `error`. The share of a zone that people use when
  they see it is `used` / `seen` records.
- Do not count `visits` with `zone` or `name`: such a query reads every
  record and is slow.
- Before you report numbers, check `skippedDays` and `failedServers` in the
  `--json` answer.

## Rules

- Ask before `app add`, `app rm`, `restore` or another command that changes
  a server.
- Do not run `imp-aly server` unless the user asks for it. As root, it installs
  a systemd service.
- Use `imp-aly token` only when the user asks for a raw call to the API.
"#;

const AGENT_INSTRUCTIONS: &str = "
imp-aly - instructions for AI agents

  Run 'imp-aly skill --init' to create a skill, then invoke it with
  /imp-aly (Claude Code, Cursor) or $imp-aly (Codex). In a git repository,
  the command writes the skill into the repository. Outside a git
  repository, it writes the skill into the home folder.

  The keys of the servers stay in the files of the user. Never ask for a
  key and never put a key in a command. Use a saved server: -s <name>.

  The full reference follows.";

#[derive(Debug, PartialEq, Eq)]
pub struct SkillRoot {
    pub dir: String,
    pub reason: &'static str,
    pub global: bool,
}

fn exists(path: &str) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub fn find_skill_root(start: &str, home: &str) -> SkillRoot {
    let mut dir = start.to_string();
    loop {
        if exists(&join(&[&dir, ".git"])) {
            return SkillRoot {
                dir,
                reason: "git root",
                global: false,
            };
        }
        let parent = dirname(&dir);
        if dir == home || parent == dir {
            break;
        }
        dir = parent;
    }
    SkillRoot {
        dir: home.to_string(),
        reason: "not in a git repository",
        global: true,
    }
}

pub fn install_skill(root: &str) -> Result<Vec<(String, &'static str)>> {
    let files: Vec<(String, &'static str)> = SKILL_TARGETS
        .iter()
        .map(|(dir, read_by)| (join(&[dir, SKILL_NAME, "SKILL.md"]), *read_by))
        .collect();
    for (path, _) in &files {
        let file = join(&[root, path]);
        if exists(&file) {
            return Err(Error::new(format!(
                "{file} exists - remove it to write the skill again"
            )));
        }
    }
    for (path, _) in &files {
        let file = join(&[root, path]);
        fs::create_dir_all(dirname(&file)).map_err(|error| Error::io(&error, &file))?;
        fs::write(&file, SKILL_CONTENT).map_err(|error| Error::io(&error, &file))?;
    }
    Ok(files)
}

pub fn skill(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["init"], "skill")?;
    if parsed.positional.len() > 1 {
        return Err(Error::new("use: imp-aly skill [--init]"));
    }
    if !parsed.has("init") {
        println!("{AGENT_INSTRUCTIONS}");
        println!("{}", help_text());
        return Ok(());
    }
    let root = find_skill_root(&cwd(), &home());
    let files = install_skill(&root.dir)?;
    if root.global {
        logger::plain(format!(
            "Not in a git repository - the skill is for all projects, in {}",
            root.dir
        ));
    } else {
        logger::plain(format!("Project root: {} ({})", root.dir, root.reason));
    }
    for (path, read_by) in files {
        logger::plain(format!("Created {path}  ({read_by})"));
    }
    logger::plain("");
    logger::plain("Try: /imp-aly how many visits did myapp have last week, per page");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn in_a_git_repository_the_skill_goes_to_the_git_root() {
        let dir = TempDir::new();
        let home = dir.join("home");
        fs::create_dir_all(format!("{home}/repo/.git")).unwrap();
        fs::create_dir_all(format!("{home}/repo/packages/app/src")).unwrap();
        let root = find_skill_root(&format!("{home}/repo/packages/app/src"), &home);
        assert_eq!(
            root,
            SkillRoot {
                dir: format!("{home}/repo"),
                reason: "git root",
                global: false
            }
        );
    }

    #[test]
    fn outside_a_git_repository_the_skill_goes_to_the_home_folder() {
        let dir = TempDir::new();
        let home = dir.join("home");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(format!("{home}/notes")).unwrap();
        fs::create_dir_all(dir.join("other")).unwrap();
        let root = find_skill_root(&format!("{home}/notes"), &home);
        assert_eq!(
            root,
            SkillRoot {
                dir: home.clone(),
                reason: "not in a git repository",
                global: true
            }
        );
        assert_eq!(find_skill_root(&home, &home).dir, home);
        assert_eq!(find_skill_root(&dir.join("other"), &home).dir, dir.path);
    }

    #[test]
    fn the_skill_is_written_for_each_agent_and_not_replaced() {
        let dir = TempDir::new();
        let files = install_skill(&dir.path).unwrap();
        let paths: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(
            paths,
            [
                ".agents/skills/imp-aly/SKILL.md",
                ".claude/skills/imp-aly/SKILL.md"
            ]
        );
        for path in paths {
            assert_eq!(fs::read_to_string(dir.join(path)).unwrap(), SKILL_CONTENT);
        }
        assert!(SKILL_CONTENT.starts_with("---\nname: imp-aly\n"));
        fs::remove_file(dir.join(".agents/skills/imp-aly/SKILL.md")).unwrap();
        assert!(
            install_skill(&dir.path)
                .unwrap_err()
                .message
                .contains("claude/skills/imp-aly/SKILL.md exists")
        );
        assert!(!exists(&dir.join(".agents/skills/imp-aly/SKILL.md")));
    }
}
