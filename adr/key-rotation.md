# The key changes with a command on the VPS, and the server does not stop

## Context

When the key leaks, the owner must change it at once. A restart stops `/collect` for a short time,
and the records of that time are lost. An API endpoint that changes the key is not safe: the person
who has the leaked key can call it first and lock the owner out. The systemd service does not read
the key file. It reads a copy that `LoadCredential=` makes at the start, and that copy does not
change.

## Decision

**`sudo imp-aly key rotate` on the VPS makes a new key, and the running server loads it on `SIGHUP`.
Only root on the VPS can change the key.**

- The command reads the key file and the data folder from the unit file. It writes the new key to
  the key file first, through a temporary file and a rename, with mode `600`. So the next start of
  the service loads the new key.
- When the service runs, the command gives the new key to the service through `/run/imp-aly`. Root
  owns that folder, with the group `imp-aly` and mode `750`. The command writes `new-key` there with
  mode `640`, owned by `root:imp-aly`, through a temporary file and a rename. Then it sends `SIGHUP`
  to the main process with `systemctl kill`. The unit file does not change.
- Root never writes, changes the owner of or reads a file in a folder that the service user can
  write. `chown` and `chmod` follow a symbolic link. In the data folder, a process of the service
  user could replace the file with a link to `/etc/shadow` between two steps of root. The service
  user cannot write `/run/imp-aly`, so it cannot do that there.
- The command refuses `/run/imp-aly` when it is not a folder that root owns, such as a symbolic
  link. The unit file has no `RuntimeDirectory=`, because systemd gives that folder to the service
  user.
- On `SIGHUP`, the service reads `new-key`, makes a new token verifier and writes `key-loaded` in
  its data folder. The service cannot remove `new-key`. The command removes `key-loaded` before the
  signal, and waits up to 5 seconds until it is there again, else it shows an error. Root only
  removes and looks at `key-loaded`. It never reads or follows it.
- The command removes `new-key` after the wait, also on an error. The service reads `new-key` only
  on `SIGHUP`, never at its start.
- The command writes the key file before `new-key`. So a restart at any time loads the new key from
  the key file. A `SIGHUP` before the signal listener stops the process, and systemd starts it again
  with the new key.
- A server in the foreground reads its key file again on `SIGHUP`. `imp-aly key rotate [-a <file>]`
  writes that file. The command cannot find the process, so the owner sends the signal.
- The API has no endpoint that changes the key.

## Consequences

- `/collect` and the admin port do not stop when the key changes.
- The owner gives the new key to each machine that calls the server, and to the console. The command
  prints the saved servers on the VPS that hold the old key as text.
- A process that runs as the service user cannot change the key, and cannot make root change a file
  that it does not own. It can write `key-loaded` and so tell the command a wrong result. Such a
  process can already read the key.
- `/run` is a memory file system. A `new-key` that a stopped command leaves there goes away at the
  next boot.
