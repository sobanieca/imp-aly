# The server checks its TLS certificate once an hour

## Context

A certificate from Let's Encrypt lasts 90 days, and certbot renews it in place. A server that reads
the certificate only at start serves an expired certificate after the renewal, until somebody
restarts it. The owner must not need a renewal hook. The change of the certificate must not stop the
port, and a certificate that does not work must not leave the server without a listener.

## Decision

**Once an hour, the server compares the modification time and the size of the `--tls-cert` and
`--tls-key` files with the last values. When they changed, the server starts new listeners with the
new certificate next to the old ones, and then closes the old ones.**

- Each listener sets `SO_REUSEPORT` (`reusePort` of `Deno.serve`). So a second listener can open on
  the same address while the first one still listens. Linux lets only a process of the same user
  join the port. `reusePort` is an unstable API of Deno, so `deno.json` sets `"unstable": ["net"]`
  for `deno run`, `deno test` and `deno compile`.
- At start, the server first opens each address once without `SO_REUSEPORT`, and closes it. So a
  port that another process uses still fails the start with `AddrInUse`, also when that process sets
  `SO_REUSEPORT`.
- In the foreground, the server reads the new files and starts a new listener on each address. Only
  when all of them run, it closes the old listeners. A closed listener takes no new connection, and
  its running requests, such as a long backup download, finish on it. The workers, the log and the
  registry keep running.
- When the new certificate does not work, or the files cannot be read, the server closes the new
  listeners that it started, keeps the old ones, and logs an error. It tries again at the next
  check, because it keeps the old times. So the server never runs without a listener.
- The service reads copies of the files from `LoadCredential=`, see
  `single-binary-systemd-service.md`. A copy does not change, so the service checks the original
  paths and stops when they change. `Restart=always` starts it again, and systemd makes new copies.
- When the server cannot check a file, it logs a warning once, and checks again later.

## Consequences

- A renewed certificate is in use at most 1 hour after the renewal, without a hook or a cron job.
- In the foreground, the port never refuses a connection during the change of the certificate. When
  an old listener closes, Linux resets the connections that wait in its queue, and the server closes
  its connections that have not sent a request yet. Such a connection fails, and the client must
  connect again. A running request finishes.
- During the about 3 seconds of a service restart, requests fail. A sink loses the records of that
  time.
- A process of the user of the server can open the same port with `SO_REUSEPORT` after the start and
  get some of the connections. The service runs as its own user, so no other program can do that.
