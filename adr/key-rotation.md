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
- When the service runs, the command writes the new key to `new-key` in the data folder, owned by
  the service user with mode `600`. Then it sends `SIGHUP` to the main process with
  `systemctl kill`. The unit file does not change.
- On `SIGHUP`, the service reads `new-key`, makes a new token verifier and removes the file. The
  command waits up to 5 seconds until the file is gone, else it shows an error.
- At its start, the service takes `new-key` when the file is there. So a `SIGHUP` that comes before
  the signal listener, or a restart between the two writes, does not lose the new key.
- The old key stops at once. There is no time in which both keys work, because the usual reason for
  the change is a leak.
- A server in the foreground reads its key file again on `SIGHUP`. `imp-aly key rotate [-a <file>]`
  writes that file. The command cannot find the process, so the owner sends the signal.
- The API has no endpoint that changes the key.

## Consequences

- `/collect` and the admin port do not stop when the key changes.
- The owner gives the new key to each machine that calls the server, and to the console. The command
  prints the saved servers on the VPS that hold the old key as text.
- A process that runs as the service user can write `new-key` and change the key. Such a process can
  already read the key.
