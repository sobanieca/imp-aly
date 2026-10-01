# One binary that installs itself as a systemd service

## Context

The owner runs the server on a cheap VPS. The server must start again after a reboot, and the owner
must see the address and the key without a search through config files. tunnelr solves the same
problem: one command installs or updates the service and prints what the owner needs.

## Decision

**`deno compile` builds one binary, and `sudo imp-analytics-server --port <port>` installs, updates
or shows the systemd service.**

- The binary includes the two worker modules with `--include`, because `deno compile` does not find
  a module that only a `Worker` URL names.
- With no subcommand, the binary is the server. As root on Linux with systemd, it writes
  `/etc/systemd/system/imp-analytics-server.service` from its options, with absolute paths for the
  data folder and the key file. The unit sets `IMP_ANALYTICS_SERVICE=1`, so the process knows that
  it runs inside the service.
- When the unit file on disk is the same, the command only prints the banner. When it differs, the
  command writes it, reloads systemd and restarts the service. So running the same command again is
  always safe.
- Without root or systemd, or with `--foreground`, the server runs in the foreground. `--uninstall`
  stops and removes the service and keeps the data and the key.
- The same binary is the client: `app`, `query`, `status` and `token` call the API.

## Consequences

- One install line and one start line give a server that survives a reboot.
- The service runs as root. An owner who wants another user writes the unit by hand with
  `--foreground`, as the CLI docs show.
- The banner prints the key in the terminal of the owner. Inside the service, the server logs only
  its port, so the key does not go to the journal.
