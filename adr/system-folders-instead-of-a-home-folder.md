# System folders instead of one folder in the home folder

## Context

The other command line tools of the owner (jsonr, sqlr, tunnelr, todoer, rfm, mock-sso, yate)
install to `~/.<tool>/bin` without `sudo` and keep all their files in `~/.<tool>`. imp-aly is
different: it is a server that runs on a VPS as a systemd service. The service runs as the system
user `imp-aly`, and its unit sets `ProtectHome`, so it cannot read or run anything in `/root` or
`/home`. The automatic update replaces the binary as root.

## Decision

**imp-aly deliberately does not use a `~/.imp-aly` folder. It keeps its files where the system
and the XDG conventions put them.**

- `install.sh` installs the binary to `/usr/local/bin` by default, for all users. The service
  refuses a binary in `/root` or `/home`, see
  [single-binary-systemd-service](single-binary-systemd-service.md).
- The service keeps its data in `/var/lib/imp-aly`, its unit in `/etc/systemd/system`, and the
  state of the automatic update in `/var/lib/imp-aly-update`, see
  [automatic-updates](automatic-updates.md).
- The client commands, on a laptop, keep the saved servers in `~/.config/imp-aly/servers.json`
  (see [saved-servers](saved-servers.md)) and, without root, the update state in
  `~/.local/state/imp-aly`. `XDG_CONFIG_HOME` and `XDG_STATE_HOME` replace these folders when set.

## Consequences

- The service works with the hardening of its unit, and a server and its update need no home
  folder.
- imp-aly does not follow the `~/.<tool>` layout of the other tools. This is on purpose: do not
  move it there.
- Removing imp-aly from a laptop means removing the binary, `~/.config/imp-aly` and
  `~/.local/state/imp-aly`.
