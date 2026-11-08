# AGENTS.md

## What this repo is

`imp-aly` is a standalone server for the analytics records of imp apps (the sibling repo
`../imp-ui`, module `imp/analytics`). It is one static binary, built with `cargo` from Rust. It runs
on a VPS, as a systemd service or in the foreground. The console is an installable web app (PWA)
with reports, an imp project in `console/`. It keeps the servers and their keys in the browser and
calls the admin ports directly. GitHub Pages serves it at `/console/`, and `imp-aly console` serves
it on localhost. The binary holds the built page.

## imp-aly is unreleased - do not preserve backward compatibility

Until the version in `Cargo.toml` reaches `1.0.0`, treat the project as never released. Rename or
remove anything, change the data layout, the API or the CLI, when a better design shows up. Never
add a compatibility shim, a fallback path or a migration note. Fix every call site, the docs and the
ADRs in the same change. Docs and ADRs describe what the code does now. They are not a changelog.

There is one exception. Servers update themselves to a new patch version (see
`adr/automatic-updates.md`). **A patch release must keep the data folder, the API, the CLI and the
unit file as they are.** Bump the minor version for any change to them. Increase `DATA_FORMAT` in
`src/data_format.rs` when the old and the new version cannot read the data folder of the other.

## Few dependencies in the server

**The server uses only the crates in `Cargo.toml`:** `tokio`, `rustls`, `tokio-rustls`, `ring`,
`ureq`, `flate2` and `libc`. Do not add a crate without a strong reason, and record the reason in
`adr/rust-server-with-few-dependencies.md`. A helper that a crate would give is a small module in
`src/` with a test. JSON, the argument parser, the URL parser, the tables and the tar format are
such modules. `xtask/` is the dev tool. It uses the same crates, and `pulldown-cmark` for the site.

The console page is different:

- `console/` is an imp project. It imports `imp` and its subpaths and its own modules. Follow
  `imp skill` there, and use `imp fmt`, `imp lint` and `imp test`.
- `console/src/shared/` holds the JavaScript form of rules that the Rust code has too: the token,
  the SHA-256, the query parser and the merge, the calls to several servers, the UTC days and the
  names. **When you change one of these rules, change the Rust module and the JavaScript module in
  the same change.** `console/test/merge-cases.json` holds merge inputs and their answers. The tests
  of both sides read it. Add a case when you change the merge.

See `adr/rust-server-with-few-dependencies.md` and `adr/console-web-app.md`.

## Architecture

| Module                                        | Job                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.rs`, `src/commands/mod.rs`          | the entry point, and the run of one command                                                                                                  |
| `src/commands/`                               | `server`, `update`, `app`, `query`, `backup`, `restore`, `status`, `console`, `token`, `key`, `add`/`group`/`ls`/`use`/`rm`, `skill`, `help` |
| `src/args.rs`                                 | the argument parser                                                                                                                          |
| `src/http.rs`                                 | the HTTP/1.1 server: the connection gate, the deadlines, the head and body reader, TLS, the graceful stop                                    |
| `src/server.rs`                               | `start_server()`: the routes, the threads, the log, the registry, the limiter, the query runner                                              |
| `src/records.rs`                              | the checks of one imp record                                                                                                                 |
| `src/apps.rs`, `src/app_build.rs`             | the app registry in `apps.json`, and reading `app-analytics.json`                                                                            |
| `src/rate_limit.rs`                           | the sliding windows per client address                                                                                                       |
| `src/in_flight.rs`                            | the requests in progress of a port, and the share of one client address                                                                      |
| `src/ip.rs`                                   | the client address, the trusted proxies, and the `/64` and `/48` keys                                                                        |
| `src/origins.rs`                              | the origins of an app, and the check of the `Origin` header of a request to the public endpoint                                              |
| `src/bots.rs`                                 | the check of the headers of a bot and of a prerendered page                                                                                  |
| `src/wal.rs`                                  | the write-ahead log with group commit and parts, on its own thread                                                                           |
| `src/storage.rs`                              | the single writer thread: log parts to columns, restore, seal, retention                                                                     |
| `src/column_store.rs`, `src/rle.rs`           | the column files, the append transaction, sealing, reading                                                                                   |
| `src/seal_sort.rs`                            | the sort of a day in chunks, and the merge of the chunks into the run files                                                                  |
| `src/line_files.rs`                           | the reading and writing of line files in blocks, and the line reader that passes each line as bytes                                          |
| `src/summary.rs`                              | the daily summary of a sealed day: build, parse, check, and the merge of days into a week or a month                                         |
| `src/live.rs`                                 | the running summary of each open day of the own source, its state on the disk, and its rebuild from the columns                              |
| `src/periods.rs`                              | the week and month summaries of a source: paths, the check that one is current, the build at seal                                            |
| `src/backup.rs`, `src/tar.rs`                 | the backup stream of the summaries, and the restore                                                                                          |
| `src/query_core.rs`                           | the query parser, the groups and the merge of the answers of servers                                                                         |
| `src/parallel.rs`                             | the run of the parts of a query on several threads, with the results in the order of the parts                                               |
| `src/scan.rs`                                 | the scan of a day: the column readers in blocks of runs of `u32` ids, the dictionaries, the filters and groups on ids                        |
| `src/query.rs`                                | the query engine over the day folders and the daily, week and month summaries, with a stop flag                                              |
| `src/query_cache.rs`, `src/fast_hash.rs`      | the folders, sealed metas, parsed summaries and counts that the query engine keeps in memory, and the fast map of `u32` ids                  |
| `src/retention.rs`                            | the free space with `statvfs`, the free space rule, old days to summaries, then removal of days, weeks and months                            |
| `src/auth.rs`                                 | the key, the key file, and the new key that root hands over in `/run/imp-aly` and the service takes on SIGHUP                                |
| `src/token.rs`                                | the one-time tokens signed per request, and the SHA-256                                                                                      |
| `src/days.rs`, `src/names.rs`                 | the UTC days, weeks and months, and the rules of the names                                                                                   |
| `src/json.rs`, `src/url.rs`, `src/table.rs`   | JSON with the key order kept, the URL parser like the WHATWG one, and the text tables of the CLI                                             |
| `src/servers.rs`, `src/api_client.rs`         | the saved servers and groups of the CLI, and the calls of the CLI to the API                                                                 |
| `src/console.rs`, `src/static_files.rs`       | the local console: a listener that serves the page from the binary, the host check and the security headers                                  |
| `build.rs`                                    | puts the files of `console/dist` into the binary                                                                                             |
| `src/service.rs`                              | the systemd unit, the service user and its limits, the update timer, the restart with a check, the new key, the local service of the client  |
| `src/update.rs`                               | the version list, the publish dates, the rules of the choice, the download with its checks, the swap of the binary                           |
| `src/data_format.rs`                          | the data format in `format.json`, which the server checks at start                                                                           |
| `src/source.rs`                               | the random source id of the server in `source.json`; a day has one folder per source                                                         |
| `src/file_watch.rs`                           | the hourly check of the TLS files                                                                                                            |
| `src/testing.rs`, `tests/support/`            | the temporary folders and the test server with a raw HTTP client                                                                             |
| `xtask/src/main.rs`, `xtask/src/demo_data.rs` | the dev tasks, the demo in `.dev-data/`, the sample records of the apps `shop`, `crm` and `docs`, and `versions.json`                        |
| `xtask/src/bench.rs`                          | the query benchmark and its data in `.bench-data/`                                                                                           |
| `xtask/src/site.rs`, `xtask/src/highlight.rs` | the site build: the docs pages from `docs/*.md`, the checks of their links, the layout, and the highlight of code blocks                     |
| `console/`                                    | the imp project of the PWA: `src/app.js`, `src/screens/`, `src/parts/`, `src/lib/` (`vault.js`, `client.js`), `src/shared/`, `test/`         |
| `site/`                                       | the sources of the site: `overview.html` (the landing page content), `site.css`, `site.js`, `mark.svg`; the build writes `site/dist/`        |

Rules that keep the server safe:

- **Every read from a socket has a size limit and a deadline.** `src/http.rs` limits the head, each
  body and each write. Never read a body without `read_all` or a reader with an idle deadline. See
  `adr/connection-limits-and-deadlines.md`.
- **A blocking step never runs on a `tokio` worker.** File work, queries and the WAL run on their
  own threads or in `spawn_blocking`. A query reads its parts with `std::thread::scope` threads.
- **A panic in a thread must not stop the server.** The storage thread restarts after 5 seconds, and
  the query thread fails only the one query.

Rules that keep the data correct:

- **The storage thread is the only writer of `apps/`.** Never write column files from an HTTP
  handler or the query thread.
- **Line N of every column file in a folder is record N.** Append only through `append_records`,
  which commits with `commit.json` and reverts on error. A reader reads up to the committed sizes.
- **Stored text takes an allowlist of characters.** `src/records.rs` allows only ASCII letters,
  digits and a few signs in zones, names, segment values and countries. `check_summary` in
  `src/summary.rs` applies the same checks to restored summaries. Keep it so when you add a field.
- **The summary path and the scan path of a query must give the same result.** `tests/summary.rs`
  compares them. Add a case there when you add a query feature.
- **The answer of N servers must equal the answer of one server with all the records.** A server
  sends counts, never a finished measure. `tests/summary.rs` splits the visits over two data folders
  and compares. Keep every new measure mergeable. A server with the sources of N servers must give
  the same answer too: a query counts each source of a day on its own and adds them. A week or a
  month summary keeps `visits` per source and per day, so it answers like its days.
- **The data folder stays the same as before the move to Rust.** `tests/fixtures/` holds answers
  that the first version gave. `tests/summary.rs` compares them.
- **The console and the CLI must give the same numbers.** The page merges the answers of servers
  with `console/src/shared/multi-server.js` and `query-core.js`, like the CLI. Never compute a
  measure in the page from finished rows of two answers. Ask with one query instead.
- **The page never keeps a key as text.** `console/src/lib/vault.js` imports the key as a
  non-extractable `CryptoKey` and stores that in IndexedDB. Never write a key to `localStorage`, a
  state, a log or the DOM. A form field for a key takes `secret: true`, as in
  `console/src/parts/key-field.js`, so the key stays out of the form state.
- **The admin port allows CORS from every origin.** The token protects each call. Never add a cookie
  or an address check that a browser could use without the key.

## Commands

The tasks are cargo aliases in `.cargo/config.toml`. They run `xtask`.

| Command                  | What it does                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo start`            | starts a demo: a server on ports 4411 and 4410 (admin) in `.dev-data/` with 45 days of sample data, a new visit every 3 seconds, and the console on port 4400 |
| `cargo server`           | runs the server from source in the foreground on ports 4411 and 4410                                                                                          |
| `cargo console`          | builds the page, then runs the console from source on port 4400                                                                                               |
| `cargo console-build`    | runs `imp build --pwa` in `console/`, which writes `console/dist`                                                                                             |
| `cargo test`             | runs the unit tests and `tests/`                                                                                                                              |
| `cargo verify`           | runs `cargo fmt --check`, `cargo clippy -D warnings`, the tests, then `imp fmt --check`, `imp lint` and `imp test --unit` in `console/`                       |
| `cargo compile`          | builds the page and the release binary `target/release/imp-aly` with the page inside                                                                          |
| `cargo site`             | builds the site into `site/dist/` and serves that folder with `rfm`                                                                                           |
| `cargo xtask build-site` | builds the site into `site/dist/`: the landing page, the docs, the console, `install.sh` and `versions.json`; `--pages` builds the console for GitHub Pages   |
| `cargo query-bench`      | writes 180 sealed days, 1M records of today and a day of 10M records in `.bench-data/` once, then prints the query times; `--reset` writes the data again     |

After a batch of changes, run `cargo fmt --all`, then `cargo verify`, and fix every issue. When you
change the HTTP layer, a thread, the server start or the CLI, also run `cargo compile` and try the
binary: start it with `server --foreground -d <temp folder>`, register an app, post a record, and
query it. When you change the console, run `cargo start`, open the link that it prints, add the demo
server with the name, the URL and the key that it prints, and look at each screen that you changed
in a browser. The demo keeps its data and its key in `.dev-data/` of the repo, which git ignores.
The folder stays after a stop, so the next start uses the same data and key. `cargo start --reset`
removes the folder and writes new sample data.

Tests use `#[test]` and the helpers in `tests/support/`. A test that starts a server uses port `0`,
a temporary data folder, `min_free: None` and `logger::set_quiet(true)`, and shuts the server down.

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

The site shows each page of `docs/` at `/docs/<name>/`. Add a new page to `PAGE_ORDER` in
`xtask/src/site.rs`. A link between pages is a relative link such as `apps.md#segments`. The build
fails on a link to a missing page or heading. `rfm` serves the local site. It is a static file
server on the machine, not part of the repo. Install it from
<https://sobanieca.github.io/remote-file-manager/>.

`docs/` is for a person who runs the server and sends records from an imp app. That reader never
reads the source. Explain what the reader does and what the server does for them. Do not point at
source files, function names, `adr/` or `todo/`. When you change a feature, update its docs page,
`imp-aly help` in `src/commands/help.rs`, and the ADR in the same change.

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
- **File names use hyphens**, never underscores. Rust modules are the exception: they use
  underscores, because a module name must be an identifier.
- **No comments in code.** Use clear names. Put reasons in the docs and the ADRs.
- **Rust**: edition 2024, `cargo fmt` and `cargo clippy -D warnings` clean. Return
  `crate::error::Result`, and never `unwrap` a value from a client or from the disk.
- **JavaScript in `console/`**: `const`/`let`, arrow functions, `async`/`await`, optional chaining.
  No semicolons, single quotes, 100 columns. `imp fmt` enforces it.

## Git

Commit on the branch that is checked out. When it is `main`, commit to `main`. Commit the changes
when they are complete. Do not wait for the person to ask. Do not push. Push only when the person
asks. `cargo verify` must pass before a commit.

## Versioning and release

Bump `version` in `Cargo.toml` to release, and run `cargo build` so that `Cargo.lock` has it too. On
a push to `main`, CI checks the code, builds the static binaries for Linux (musl) and macOS on x64
and arm64 when the tag `v<version>` does not exist, runs a smoke test of each binary, and publishes
them with SHA-256 files to a GitHub Release. Then GitHub Pages serves the site of
`cargo xtask build-site --pages`: the landing page, the docs, the console, `install.sh` and
`versions.json`, the list of released versions with their data format. The update timer on each
server reads that list. Before `1.0.0`, it installs only a patch version of the same
minor version, and only 7 days after GitHub published it. See `adr/binary-distribution.md` and
`adr/automatic-updates.md`.
