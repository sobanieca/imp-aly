# The server checks its TLS certificate once an hour

## Context

A certificate from Let's Encrypt lasts 90 days, and certbot renews it in place. A server that reads
the certificate only at start serves an expired certificate after the renewal, until somebody
restarts it. The owner must not need a renewal hook. The change of the certificate must not stop the
port, and a certificate that does not work must not leave the server without a listener.

## Decision

**Once an hour, the server compares the modification time and the size of the `--tls-cert` and
`--tls-key` files with the last values. When they changed, the server reads them, and each new
connection uses the new certificate.**

- The listeners keep running. The server builds a new TLS configuration from the new files and puts
  it in the place of the old one. A connection that is open keeps the certificate of its handshake,
  and its running requests, such as a long backup download, finish.
- When the new certificate does not work, or the files cannot be read, the server keeps the old
  configuration and logs an error. It tries again at the next check, because it keeps the old times.
- At start, a port that another process uses fails the start with a message that the port is in use.
- The service reads copies of the files from `LoadCredential=`, see
  `single-binary-systemd-service.md`. A copy does not change, so the service checks the original
  paths and stops when they change. `Restart=always` starts it again, and systemd makes new copies.
- When the server cannot check a file, it logs a warning once, and checks again later.

## Consequences

- A renewed certificate is in use at most 1 hour after the renewal, without a hook or a cron job.
- In the foreground, the port never refuses a connection during the change of the certificate, and
  no connection is reset.
- During the about 3 seconds of a service restart, requests fail. A sink loses the records of that
  time.
