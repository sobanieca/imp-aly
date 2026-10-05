# Architecture Decision Records

Each ADR captures one architectural decision: the context that forced it, the decision, and the
consequences. Every ADR in this folder is the current, accepted state of that decision. There is no
status field. When a decision changes, replace its ADR. When a decision is dropped, delete its ADR.

- **A file name is a short, descriptive slug of the decision.** There is no number.
- **The format of a record is Context, Decision, Consequences.**
- **Presence means accepted.** The folder reflects what the code does.

## Runtime and distribution

| ADR                                                                                   | Decision                                                   |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [plain-javascript-dependency-free-server](plain-javascript-dependency-free-server.md) | Plain JavaScript on Deno, with no dependency in the server |
| [single-binary-systemd-service](single-binary-systemd-service.md)                     | One binary that installs itself as a systemd service       |
| [binary-distribution](binary-distribution.md)                                         | Binaries on GitHub Releases, with a checksum               |
| [tls-certificate-check](tls-certificate-check.md)                                     | The server checks its TLS certificate once an hour         |

## Collection

| ADR                                                                 | Decision                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| [build-file-record-validation](build-file-record-validation.md)     | Records are checked against the build file and strict rules |
| [per-address-sliding-rate-limit](per-address-sliding-rate-limit.md) | A rate limit per address, in four sliding windows           |
| [in-flight-request-cap](in-flight-request-cap.md)                   | A cap on the requests in progress per port, then `503`      |
| [collect-origin-allowlist](collect-origin-allowlist.md)             | The public endpoint can accept only the allowed origins     |
| [utc-day-from-record-time](utc-day-from-record-time.md)             | The day of a record is the UTC day of its `at`              |
| [write-ahead-log-group-commit](write-ahead-log-group-commit.md)     | Records go to a synced write-ahead log before the answer    |

## Storage

| ADR                                                                 | Decision                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [single-writer-storage-worker](single-writer-storage-worker.md)     | One storage worker is the only writer of the data                        |
| [plain-text-column-files](plain-text-column-files.md)               | Plain text column files, one folder per app and day                      |
| [append-transaction-with-revert](append-transaction-with-revert.md) | An append to the columns is a transaction that reverts                   |
| [sealed-days-sorted-runs](sealed-days-sorted-runs.md)               | A finished day is sorted and stored as runs                              |
| [daily-summaries](daily-summaries.md)                               | A sealed day carries a summary that queries read                         |
| [disk-space-retention](disk-space-retention.md)                     | Retention follows free disk space, and keeps summaries longest           |
| [summary-backups](summary-backups.md)                               | Backups hold the daily summaries, and a restore writes summary-only days |

## Access

| ADR                                                                             | Decision                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [one-time-token-admin-api](one-time-token-admin-api.md)                         | The private API takes one-time tokens signed with a key                |
| [separate-admin-port](separate-admin-port.md)                                   | The private API has its own port                                       |
| [security-headers](security-headers.md)                                         | Every answer carries headers that stop a browser from running it       |
| [json-query-api-in-a-worker](json-query-api-in-a-worker.md)                     | Queries are JSON objects, run one at a time in a worker                |
| [saved-servers](saved-servers.md)                                               | The client keeps a list of named servers and a default                 |
| [several-servers-merged-by-the-client](several-servers-merged-by-the-client.md) | Servers hold separate visits, and the client adds up their answers     |
| [agent-skill-location](agent-skill-location.md)                                 | The agent skill goes to the git repository, or else to the home folder |
| [local-console](local-console.md)                                               | A local console with a web page, on top of the client code             |
