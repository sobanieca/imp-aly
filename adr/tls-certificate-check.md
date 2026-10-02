# The server checks its TLS certificate once an hour

## Context

A certificate from Let's Encrypt lasts 90 days, and certbot renews it in place. A server that reads
the certificate only at start serves an expired certificate after the renewal, until somebody
restarts it. The owner must not need a renewal hook.

## Decision

**Once an hour, the server compares the modification time and the size of the `--tls-cert` and
`--tls-key` files with the last values. When they changed, the server loads the new certificate.**

- In the foreground, the server reads the new files, stops its listener gracefully, and starts a new
  listener on the same address with the new certificate. The workers, the log and the registry keep
  running.
- When the new certificate does not work, or the files cannot be read, the server logs an error and
  keeps the old certificate. It tries again at the next check, because it keeps the old times.
- The service reads copies of the files from `LoadCredential=`, see
  `single-binary-systemd-service.md`. A copy does not change, so the service checks the original
  paths and stops when they change. `Restart=always` starts it again, and systemd makes new copies.
- When the server cannot check a file, it logs a warning once, and checks again later.

## Consequences

- A renewed certificate is in use at most 1 hour after the renewal, without a hook or a cron job.
- During the restart of the listener, and for about 3 seconds of a service restart, requests fail. A
  sink loses the records of that time.
- A graceful stop of the listener waits for running requests, such as a long backup download.
