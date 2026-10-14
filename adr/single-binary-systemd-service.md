# One binary that installs itself as a systemd service

## Context

The owner runs the server on a cheap VPS. The server must start again after a reboot, and the owner
must see the address and the key without a search through config files. tunnelr solves the same
problem: one command installs or updates the service and prints what the owner needs.

## Decision

**`cargo build --release` builds one binary, and `sudo imp-aly server --port <port>` installs,
updates or shows the systemd service.**

- The binary holds the server, the client commands and the built page of the console. A build script
  puts the files of `console/dist` into the binary.
- The `server` command is the server, as in tunnelr. Without a command, the binary prints the help.
  As root on Linux with systemd, `server` writes `/etc/systemd/system/imp-aly.service` from its
  options, with an absolute path for the data folder. The unit sets `IMP_ALY_SERVICE=1`, so the
  process knows that it runs inside the service.
- The service runs as the system user `imp-aly`. The command creates it with `useradd --system` and
  no login shell, and gives it the data folder with `chown -R`. The default data folder of the
  service is `/var/lib/imp-aly`.
- The key file and the TLS files stay owned by root. The unit names them with `LoadCredential=`, and
  the server reads the copies from `$CREDENTIALS_DIRECTORY`. So the service user never reads a file
  of root, and the key is not in the unit file. A new key reaches the running service in the data
  folder, see `key-rotation.md`.
- The unit limits the service: `ProtectSystem=strict` with `ReadWritePaths=` for the data folder,
  `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`, the kernel, clock, hostname and
  control group protections, `ProtectProc=invisible`, `RestrictNamespaces`, `RestrictRealtime`,
  `RestrictSUIDSGID`, `LockPersonality` and `RemoveIPC`. `RestrictAddressFamilies=` allows only
  `AF_UNIX`, `AF_INET` and `AF_INET6`. `SystemCallArchitectures=native` and
  `SystemCallFilter=@system-service` limit the system calls, and a blocked call fails with `EPERM`.
  The capability set is empty, or only `CAP_NET_BIND_SERVICE` for a port below 1024. `UMask=0077`
  keeps new files private. `MemoryDenyWriteExecute=true` refuses memory that is both writable and
  executable, because the binary has no JIT. `LimitNOFILE=65536` gives room for the connections of
  both ports, and `TasksMax=4096` caps the threads.
- `ProtectSystem=strict` makes `/run` read-only for the service. The service only reads the new key
  that root puts in `/run/imp-aly`, see `key-rotation.md`, so the handover still works.
- The command refuses a data folder in `/root`, a binary in `/root` or `/home`, which the unit
  hides, and a credential path that `LoadCredential=` cannot take. It checks with `runuser` that the
  service user can reach the parent folder before it creates the data folder, and can write the data
  folder after. When a check fails, the command removes the folders that it created.
- When the unit file on disk is the same, the command only prints the banner. When it differs, the
  command writes it, reloads systemd and restarts the service. So running the same command again is
  always safe.
- Without root or systemd, or with `--foreground`, the server runs in the foreground with the data
  folder `~/.imp-aly`. `--uninstall` stops and removes the service and the update timer, and keeps
  the data, the key and the user.
- The command also installs the timer `imp-aly-update`, unless `--no-auto-update` is given. See
  [automatic-updates](automatic-updates.md).
- The same binary is the client: `app`, `query`, `backup`, `restore`, `status` and `token` call the
  API. `add`, `ls`, `use` and `rm` keep a list of named servers for them, as the saved connections
  of tunnelr do. See [saved-servers](saved-servers.md).

## Consequences

- One install line and one start line give a server that survives a reboot.
- The process runs at most 64 threads for blocking file work, next to the threads of the HTTP
  server, the storage, the queries and the log.
- A fault in the server cannot change the system, read the files of root, or get more privileges.
- `LoadCredential=` needs systemd 247 or newer: Debian 11, Ubuntu 22.04 and later.
- A data folder that the service user cannot reach, such as one below a private home folder, fails
  at install, with a message.
- The banner prints the key in the terminal of the owner. Inside the service, the server logs only
  its port, so the key does not go to the journal.
