# A systemd timer installs a compatible release after 7 days

## Context

The server runs all the time on a VPS. The owner must get fixes without a manual step on each
server. An update must not damage the data folder, must not stop a running server before the new
binary is ready, and must undo itself when the new version does not start. The service runs as a
user that cannot write the binary, and it must stay so. An update installs code as root on every
server. So a bad or a forged release must not reach all servers at once.

## Decision

**`sudo imp-aly server` installs the systemd timer `imp-aly-update`. Once a day it runs
`imp-aly update --auto` as root. That installs the newest version of the same major version that
GitHub published more than 7 days ago. It restarts the service, and puts the old binary back when
the service does not stay running.**

- **The version list.** The Pages job of CI writes `versions.json` next to `install.sh`. It holds
  each tag `v<version>` whose `Cargo.toml` has that version, with the data format of that tag. A
  release that is not in the list cannot be an update. To withdraw a release, delete its tag and its
  GitHub Release.
- **The data format.** `DATA_FORMAT` in `src/data_format.rs` is a whole number. The server writes it
  to `format.json` in a new data folder, and refuses to start on a data folder with another format.
  Increase it when a change makes the data folder unreadable for the older version, or the reverse.
- **The rules of the timer.** `update --auto` installs a version only when it is newer than the
  installed version, has the same data format, is in the same major version, has a release that
  GitHub published more than 7 days ago, and is not in the skip list. It takes the newest version
  that passes all the rules.
- **The major version before `1.0.0`.** Semantic versioning gives no stable API before `1.0.0`. In
  this project, a minor version before `1.0.0` can change the data folder, the API, the CLI and the
  unit file, as a major version can from `1.0.0`. So before `1.0.0`, the timer stays in the same
  minor version: `0.1.x`. From `1.0.0`, it stays in the same major version: `1.x.y`.
- **The age of a release.** The command reads `published_at` of each release from the GitHub API,
  `GET /repos/sobanieca/imp-aly/releases`. GitHub sets that date when it publishes the release. So
  nothing in the release, the tag or `versions.json` can make a release look older. The API skips
  drafts and prereleases. A version with no date is too new. The 7 days give the owner time to find
  a bad or a forged release, and to delete it, before the timer installs it.
- **A manual update.** `imp-aly update` without `--auto` skips the major version rule and the age
  rule. The owner runs it to install a new major version. It keeps all the other rules: newer only,
  the same data format and the skip list. No mode of the command installs an older version. To go
  back, the owner uses `.imp-aly.previous`.
- `update` names each newer version that it does not install, with the reason. `update --check`
  shows the version of a manual update and the version of the timer.
- **The download.** The command downloads `releases/download/v<version>/<asset>.sha256`. Then it
  downloads the asset to `.imp-aly.new` in the folder of the binary, checks the SHA-256 and the
  asset name from the `.sha256` file, and runs `--version` on it. The version must be the version
  that it selected. A failed step removes the file and changes nothing.
- **The swap.** The command makes the hard link `.imp-aly.previous` to the old binary, then renames
  `.imp-aly.new` to the binary. A rename in one folder is atomic. The running server keeps its open
  copy of the old binary, so it runs on without a change until the restart.
- **The restart.** When the service is active, the command runs `systemctl restart imp-aly`. The
  server stops as on `SIGTERM`: it ends the requests in progress and closes the write-ahead log. The
  new process reads the log again. Records that arrive in the 1 to 3 seconds of the restart get no
  answer. The sink of imp sends them to the next server in its list.
- **The check and the rollback.** For 15 seconds the service must stay `active`, with the same main
  process and the same restart count. If not, the command renames `.imp-aly.previous` back, restarts
  the service again, adds the version to `/var/lib/imp-aly-update/skipped.json`, and fails. The
  timer does not try a skipped version again.
- **The timer and its service.** `OnCalendar=daily` with `RandomizedDelaySec=6h`, so servers in a
  group do not restart at the same time, and `Persistent=true`. The update service is a `oneshot`
  that can write only the folder of the binary and its state folder. It has the sandbox of the
  server service, see `single-binary-systemd-service.md`, with two changes. It runs as root, and
  keeps only `CAP_DAC_OVERRIDE` and `CAP_FOWNER`, so it can replace and link a binary that another
  user owns. It does not set `ProtectProc` and `RemoveIPC`, which a root service does not need. The
  server service stays as it is: it cannot write the binary.
- `--no-auto-update` removes the timer. `--uninstall` removes it with the service. Without the
  service, `update` replaces the binary, and the owner restarts the server.
- **The lock.** A lock file in the state folder stops two updates at the same time. The command
  takes the lock first, before it reads the versions. A second update fails at once. With the lock,
  the command runs the binary on disk with `--version`. When that is not the version that runs the
  command, another update replaced the binary after this command started. The command then stops. So
  `.imp-aly.previous` always holds the version before the last swap, and a rollback never puts a
  wrong binary back.

## Consequences

- A patch release reaches every server between 7 and 8 days after GitHub publishes it, with no step
  from the owner. An urgent fix waits too, unless the owner runs `sudo imp-aly update`.
- The timer reads the GitHub API once a day. That is far below the limit of the API for a client
  with no token. When the API fails, the timer installs nothing and tries again the next day.
- A patch release before `1.0.0` must keep the data format, the API and the unit file. A change of
  them needs a new minor version.
- A change to the unit file comes only with `sudo imp-aly server`, which the owner runs after a
  manual update to a new minor or major version. The command says so after such an update.
- The old binary stays on the disk, so the owner can go back with one `mv`.
- The server with no other server in the sink loses the records of a few seconds once per update.
