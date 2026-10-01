# CLAUDE.md

## What this repo is

`imp-analytics-server` is a standalone server for the analytics records of imp apps (the sibling
repo `../imp-ui`, module `imp/analytics`). It is one binary, built with `deno compile` from plain
JavaScript. It runs on a VPS, as a systemd service or in the foreground.

## imp-analytics-server is unreleased - do not preserve backward compatibility

Until the version in `deno.json` reaches `1.0.0`, treat the project as never released. Rename or
remove anything, change the data layout, the API or the CLI, when a better design shows up. Never
add a compatibility shim, a fallback path or a migration note. Fix every call site, the docs and the
ADRs in the same change. Docs and ADRs describe what the code does now. They are not a changelog.

## No dependencies

**Import nothing from outside the repo.** No `jsr:`, `npm:` or URL import, also not in tests. Use
the Deno runtime and the web platform: `Deno.serve`, `Deno.open`, `Worker`, `crypto.subtle`,
`fetch`, `Deno.Command`. A helper that a library would give is a small module in `src/` with a test.
See `adr/plain-javascript-no-dependencies.md`.

## Architecture

| Module                                | Job                                                              |
| ------------------------------------- | ---------------------------------------------------------------- |
| `main.js`                             | parses the arguments and runs a command                          |
| `src/commands/`                       | `serve` (the default), `app`, `query`, `status`, `token`, `help` |
| `src/server.js`                       | `startServer()`: HTTP routes, workers, log, registry, limiter    |
| `src/records.js`                      | the checks of one imp record                                     |
| `src/apps.js`, `src/app-map.js`       | the app registry in `apps.json`, and reading `app-map.txt`       |
| `src/rate-limit.js`                   | the sliding windows per client address                           |
| `src/wal.js`                          | the write-ahead log with group commit and parts                  |
| `src/storage.js`, `storage-worker.js` | the single writer: log parts to columns, seal, retention         |
| `src/column-store.js`, `src/rle.js`   | the column files, the append transaction, sealing, reading       |
| `src/query.js`, `query-worker.js`     | the query parser and engine, run in a worker                     |
| `src/retention.js`                    | `df`, the free space rule, the removal of old days               |
| `src/auth.js`                         | the key and the one-time tokens (same scheme as `../tunnelr`)    |
| `src/service.js`                      | the systemd unit                                                 |

Rules that keep the data correct:

- **The storage worker is the only writer of `apps/`.** Never write column files from the HTTP
  thread or the query worker.
- **Line N of every column file in a folder is record N.** Append only through `appendRecords`,
  which commits with `commit.json` and reverts on error. A reader reads up to the committed sizes.
- **No stored value may hold a control character.** `src/records.js` enforces it. Keep it so when
  you add a field.
- **A new worker module must be in the `--include` list** of `deno task compile` and of the build in
  `.github/workflows/ci.yml`. `deno compile` does not find a module that only a `Worker` URL names.

## Commands

| Command             | What it does                                               |
| ------------------- | ---------------------------------------------------------- |
| `deno task start`   | runs the server from source in the foreground on port 2980 |
| `deno task test`    | runs `test/`                                               |
| `deno task check`   | runs `deno fmt`, `deno lint`, then the tests               |
| `deno task compile` | builds `./imp-analytics-server` with both workers included |

After a batch of changes, run `deno task check` and fix every issue. Keep every change that
`deno fmt` makes. When you change a worker, the server start or the CLI, also run
`deno task compile` and try the binary: start it with `--foreground -d <temp folder>`, register an
app, post a record, and query it.

Tests use `Deno.test` and the helpers in `test/assert.js`. A test that starts a server uses port
`0`, a temporary data folder, `minFree: null` and `quiet: true`, and shuts the server down.

## ADRs (`adr/`)

ADRs record accepted decisions, one per file, as in imp.

- **Presence means accepted.** No status field and no number. File names are descriptive slugs.
- **Format:** Context / Decision / Consequences.
- **When a decision changes, replace the ADR.** When it is dropped, delete it. Update the table in
  `adr/README.md` when you add, rename or remove an ADR.
- **Keep ADRs in sync with the code.** An ADR must not describe a feature that does not exist.
  Planned work goes in `todo/`, one file per item with a slug name. Delete the file when the item is
  done.

## Docs (`docs/`)

`docs/` is for a person who runs the server and sends records from an imp app. That reader never
reads the source. Explain what the reader does and what the server does for them. Do not point at
source files, function names, `adr/` or `todo/`. When you change a feature, update its docs page,
`imp-analytics-server help` in `src/commands/help.js`, and the ADR in the same change.

## Prose style - Simplified Technical English

Write all prose in Simplified Technical English (ASD-STE100): docs, ADRs, this file, commit messages
and user-facing strings. Keep code names, options and quoted output as they are.

- An instruction has 20 words or fewer. A descriptive sentence has 25 words or fewer. One topic per
  sentence.
- Active voice, present tense, the imperative for instructions. "Must" for a requirement, "can" for
  a possibility. Do not use "should", "may" or "might" for a requirement.
- One term for one thing. Simple words. No idioms, no metaphors, no humour.
- A warning states the risk first, then the instruction.

## Code style

- **ASCII only**, in every file. Write `-`, `...`, `"`, `'` and `->`, never their Unicode forms.
- **File names use hyphens**, never underscores.
- **No comments in code.** Use clear names. Put reasons in the docs and the ADRs.
- **Modern JavaScript**: `const`/`let`, arrow functions, `async`/`await`, optional chaining.
- **Format**: no semicolons, single quotes, 100 columns. `deno fmt` enforces it.

## Git

Commit on the branch that is checked out. When it is `main`, commit to `main`. Commit only when
asked. `deno fmt` and `deno lint` must pass before a commit.

## Versioning and release

Bump `version` in `deno.json` to release. On a push to `main`, CI checks the code, builds the
binaries for Linux and macOS on x64 and arm64 when the tag `v<version>` does not exist, runs a smoke
test of each binary, and publishes them with SHA-256 files to a GitHub Release. GitHub Pages serves
`install.sh`. See `adr/binary-distribution.md`.
