# CLAUDE.md

## What this repo is

`imp-aly` is a standalone server for the analytics records of imp apps (the sibling repo
`../imp-ui`, module `imp/analytics`). It is one binary, built with `deno compile` from plain
JavaScript. It runs on a VPS, as a systemd service or in the foreground. The console is an
installable web app (PWA) with reports, an imp project in `console/`. It keeps the servers and their
keys in the browser and calls the admin ports directly. GitHub Pages serves it at `/console/`, and
`imp-aly console` serves it on localhost.

## imp-aly is unreleased - do not preserve backward compatibility

Until the version in `deno.json` reaches `1.0.0`, treat the project as never released. Rename or
remove anything, change the data layout, the API or the CLI, when a better design shows up. Never
add a compatibility shim, a fallback path or a migration note. Fix every call site, the docs and the
ADRs in the same change. Docs and ADRs describe what the code does now. They are not a changelog.

There is one exception. Servers update themselves to a new patch version (see
`adr/automatic-updates.md`). **A patch release must keep the data folder, the API, the CLI and the
unit file as they are.** Bump the minor version for any change to them. Increase `DATA_FORMAT` in
`src/data-format.js` when the old and the new version cannot read the data folder of the other.

## No dependencies in the server

**Import nothing from outside the repo**, also not in tests. Use the Deno runtime and the web
platform: `Deno.serve`, `Deno.open`, `Worker`, `crypto.subtle`, `fetch`, `Deno.Command`. A helper
that a library would give is a small module in `src/` with a test.

There is one exception, for the console page only:

- `console/` is an imp project. It imports `imp` and its subpaths, its own modules, and the shared
  modules of `src/`: `token.js`, `sha256.js`, `query-core.js`, `multi-server.js` and the modules
  that they import. Follow `imp skill` there, and use `imp fmt`, `imp lint` and `imp test`, not the
  Deno tools. `deno fmt` and `deno lint` exclude `console/`.
- **A shared module of `src/` must not use a Deno API**, also not in a module that it imports.
  `imp build` bundles it into the page.

See `adr/plain-javascript-dependency-free-server.md` and `adr/console-web-app.md`.

## Architecture

| Module                                | Job                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `main.js`                             | parses the arguments and runs a command                                                                                              |
| `src/commands/`                       | `server`, `update`, `app`, `query`, `backup`, `restore`, `status`, `console`, `token`, `key`, `add`/`ls`/`use`/`rm`, `skill`, `help` |
| `src/server.js`                       | `startServer()`: HTTP routes, workers, log, registry, limiter                                                                        |
| `src/records.js`                      | the checks of one imp record                                                                                                         |
| `src/apps.js`, `src/app-build.js`     | the app registry in `apps.json`, and reading `app-analytics.json`                                                                    |
| `src/rate-limit.js`                   | the sliding windows per client address                                                                                               |
| `src/origins.js`                      | the allowed browser origins of the public endpoint                                                                                   |
| `src/wal.js`                          | the write-ahead log with group commit and parts                                                                                      |
| `src/storage.js`, `storage-worker.js` | the single writer: log parts to columns, restore, seal, retention                                                                    |
| `src/column-store.js`, `src/rle.js`   | the column files, the append transaction, sealing, reading                                                                           |
| `src/seal-sort.js`                    | the sort of a day in chunks, and the merge of the chunks into the run files                                                          |
| `src/line-files.js`                   | the reading and writing of line files in blocks                                                                                      |
| `src/summary.js`                      | the daily summary of a sealed day: build, parse and check                                                                            |
| `src/backup.js`, `src/tar.js`         | the backup stream of the summaries, and the restore                                                                                  |
| `src/query-core.js`                   | the query parser, the groups and the merge of the answers of servers, with no Deno API (shared with the page)                        |
| `src/query.js`, `query-worker.js`     | the query engine over the day folders and the summaries, run in a worker                                                             |
| `src/retention.js`                    | `df`, the free space rule, old days to summaries, then removal                                                                       |
| `src/auth.js`                         | the key, the key file, and the new key that the service takes on SIGHUP                                                              |
| `src/token.js`, `src/sha256.js`       | the one-time tokens signed per request, and a streaming SHA-256, with no Deno API (shared with the page)                             |
| `src/servers.js`, `src/api-client.js` | the saved servers of the CLI, and the calls of the CLI to the API                                                                    |
| `src/multi-server.js`                 | the calls to several servers and the sum of their answers, with no Deno API (shared with the page)                                   |
| `src/console.js`                      | the local console: a listener that serves the built page, the host check and the security headers                                    |
| `src/static-files.js`                 | the files of the built page of the console, with the fallback to `index.html`                                                        |
| `dev/start.js`, `dev/demo-data.js`    | the demo of `deno task start`, and the sample records of the app `shop`                                                              |
| `console/`                            | the imp project of the PWA: `src/app.js`, `src/screens/`, `src/parts/`, `src/lib/` (`vault.js`, `client.js`), `test/`                |
| `src/service.js`                      | the systemd unit, the service user and its limits, the update timer, the restart with a check, the new key sent to the service       |
| `src/update.js`                       | the version list, the choice of the update, the download with its checks, the swap of the binary                                     |
| `src/data-format.js`                  | the data format in `format.json`, which the server checks at start                                                                   |
| `dev/versions-manifest.js`            | writes `versions.json` for GitHub Pages from the release tags                                                                        |
| `src/file-watch.js`                   | the hourly check of the TLS files                                                                                                    |
| `site/index.html`                     | the landing page, one static file that GitHub Pages serves with `install.sh`                                                         |

Rules that keep the data correct:

- **The storage worker is the only writer of `apps/`.** Never write column files from the HTTP
  thread or the query worker.
- **Line N of every column file in a folder is record N.** Append only through `appendRecords`,
  which commits with `commit.json` and reverts on error. A reader reads up to the committed sizes.
- **Stored text takes an allowlist of characters.** `src/records.js` allows only ASCII letters,
  digits and a few signs in zones, names, segment values and countries. `checkSummary` in
  `src/summary.js` applies the same checks to restored summaries. Keep it so when you add a field.
- **The summary path and the scan path of a query must give the same result.**
  `test/summary.test.js` compares them. Add a case there when you add a query feature.
- **The answer of N servers must equal the answer of one server with all the records.** A server
  sends counts, never a finished measure. `test/summary.test.js` splits the visits over two data
  folders and compares. Keep every new measure mergeable.
- **A new worker module must be in the `--include` list** of `deno task compile` and of the build in
  `.github/workflows/ci.yml`. `deno compile` does not find a module that only a `Worker` URL names.
  `console/dist` is in the same list, so the binary serves the page.
- **The console and the CLI must give the same numbers.** The page merges the answers of servers
  with `src/multi-server.js` and `src/query-core.js`, like the CLI. Never compute a measure in the
  page from finished rows of two answers. Ask with one query instead.
- **The page never keeps a key as text.** `console/src/lib/vault.js` imports the key as a
  non-extractable `CryptoKey` and stores that in IndexedDB. Never write a key to `localStorage`, a
  state, a log or the DOM.
- **The admin port allows CORS from every origin.** The token protects each call. Never add a cookie
  or an address check that a browser could use without the key.

## Commands

| Command                   | What it does                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `deno task start`         | starts a demo: a server in a temporary folder with 45 days of sample data, a new visit every 3 seconds, and the console on port 8010 |
| `deno task server`        | runs the server from source in the foreground on ports 2980 and 2981                                                                 |
| `deno task console`       | builds the page, then runs the console from source on port 8010                                                                      |
| `deno task console:build` | runs `imp build --pwa` in `console/`, which writes `console/dist`                                                                    |
| `deno task test`          | runs `test/`                                                                                                                         |
| `deno task check`         | runs `deno fmt`, `deno lint`, the tests, then `imp fmt`, `imp lint` and `imp test --unit` in `console/`                              |
| `deno task compile`       | builds the page and `./imp-aly` with both workers and the page included                                                              |

After a batch of changes, run `deno task check` and fix every issue. Keep every change that
`deno fmt` and `imp fmt` make. When you change a worker, the server start or the CLI, also run
`deno task compile` and try the binary: start it with `server --foreground -d <temp folder>`,
register an app, post a record, and query it. When you change the console, run `deno task start`,
open the link that it prints, and look at each screen that you changed in a browser. The link adds
the demo server to the page. The demo keeps its server and its data in a temporary folder, and
removes the folder when it stops.

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
`imp-aly help` in `src/commands/help.js`, and the ADR in the same change.

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
test of each binary, and publishes them with SHA-256 files to a GitHub Release. Then GitHub Pages
serves `install.sh`, the landing page in `site/` and `versions.json`, the list of released versions
with their data format. The update timer on each server reads that list. Before `1.0.0`, it installs
only a patch version of the same minor version. See `adr/binary-distribution.md` and
`adr/automatic-updates.md`.
