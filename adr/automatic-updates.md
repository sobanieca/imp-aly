# A systemd timer installs the newest compatible version

## Context

The server runs all the time on a VPS. The owner must get fixes without a manual step on each
server. An update must not damage the data folder, must not stop a running server before the new
binary is ready, and must undo itself when the new version does not start. The service runs as a
user that cannot write the binary, and it must stay so.

## Decision

**`sudo imp-aly server` installs the systemd timer `imp-aly-update`. Once a day it runs
`imp-aly update` as root, which installs the newest compatible version, restarts the service, and
puts the old binary back when the service does not stay running.**

- **The version list.** The Pages job of CI writes `versions.json` next to `install.sh`. It holds
  each tag `v<version>` whose `deno.json` has that version, with the data format of that tag. A
  release that is not in the list cannot be an update. To withdraw a release, delete its tag and its
  GitHub Release.
- **The data format.** `DATA_FORMAT` in `src/data-format.js` is a whole number. The server writes it
  to `format.json` in a new data folder, and refuses to start on a data folder with another format.
  Increase it when a change makes the data folder unreadable for the older version, or the reverse.
- **Compatible versions.** Before `1.0.0`, an update stays in the same minor version: `0.1.x`. From
  `1.0.0`, it stays in the same major version. The data format must also be the same. `update` names
  a newer version that it does not install, and the owner installs it with `install.sh`.
- **The download.** The command downloads `releases/download/v<version>/<asset>` and its `.sha256`
  to `.imp-aly.new` in the folder of the binary, checks the SHA-256, and runs `--version` on it. A
  failed step removes the file and changes nothing.
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
  that can write only the folder of the binary and its state folder. The server service stays as it
  is: it cannot write the binary.
- `--no-auto-update` removes the timer. `--uninstall` removes it with the service. A lock file in
  the state folder stops two updates at the same time. Without the service, `update` replaces the
  binary, and the owner restarts the server.

## Consequences

- A patch release reaches every server in one day, with no step from the owner.
- A patch release before `1.0.0` must keep the data format, the API and the unit file. A change of
  them needs a new minor version.
- A change to the unit file comes only with `sudo imp-aly server`, which the owner runs after a
  manual update to a new minor or major version.
- The old binary stays on the disk, so the owner can go back with one `mv`.
- The server with no other server in the sink loses the records of a few seconds once per update.
