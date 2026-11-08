# Architecture Decision Records

Each ADR captures one architectural decision: the context that forced it, the decision, and the
consequences. Every ADR in this folder is the current, accepted state of that decision. There is no
status field. When a decision changes, replace its ADR. When a decision is dropped, delete its ADR.

- **A file name is a short, descriptive slug of the decision.** There is no number.
- **The format of a record is Context, Decision, Consequences.**
- **Presence means accepted.** The folder reflects what the code does.

## Runtime and distribution

| ADR                                                                       | Decision                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [rust-server-with-few-dependencies](rust-server-with-few-dependencies.md) | The server is Rust, with few dependencies                  |
| [single-binary-systemd-service](single-binary-systemd-service.md)         | One binary that installs itself as a systemd service       |
| [binary-distribution](binary-distribution.md)                             | Binaries on GitHub Releases, with a checksum               |
| [automatic-updates](automatic-updates.md)                                 | A systemd timer installs a compatible release after 7 days |
| [tls-certificate-check](tls-certificate-check.md)                         | The server checks its TLS certificate once an hour         |

## Collection

| ADR                                                                   | Decision                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| [build-file-record-validation](build-file-record-validation.md)       | Records are checked against the build file and strict rules |
| [per-address-sliding-rate-limit](per-address-sliding-rate-limit.md)   | A rate limit per address, in four sliding windows           |
| [in-flight-request-cap](in-flight-request-cap.md)                     | A cap on the requests in progress per port, then `503`      |
| [connection-limits-and-deadlines](connection-limits-and-deadlines.md) | Each connection has limits and deadlines                    |
| [collect-origins-per-app](collect-origins-per-app.md)                 | Each app accepts records only from its origins              |
| [collect-bot-filter](collect-bot-filter.md)                           | The records of bots and prerendered pages are rejected      |
| [utc-day-from-record-time](utc-day-from-record-time.md)               | The day of a record is the UTC day of its `at`              |
| [write-ahead-log-group-commit](write-ahead-log-group-commit.md)       | Records go to a synced write-ahead log before the answer    |

## Storage

| ADR                                                                 | Decision                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [single-writer-storage-worker](single-writer-storage-worker.md)     | One storage thread is the only writer of the data                              |
| [plain-text-column-files](plain-text-column-files.md)               | Plain text column files, one folder per app and day                            |
| [streaming-scan-on-ids](streaming-scan-on-ids.md)                   | A scan reads the columns in blocks and works on ids of the values              |
| [source-folders-per-server](source-folders-per-server.md)           | Each server has a source id, and a day has one folder per source               |
| [append-transaction-with-revert](append-transaction-with-revert.md) | An append to the columns is a transaction that reverts                         |
| [sealed-days-sorted-runs](sealed-days-sorted-runs.md)               | A finished day is sorted and stored as runs                                    |
| [daily-summaries](daily-summaries.md)                               | A sealed day carries a summary that queries read                               |
| [running-summary-of-open-days](running-summary-of-open-days.md)     | The storage worker keeps a running summary of each open day in memory          |
| [week-and-month-summaries](week-and-month-summaries.md)             | Each source keeps a summary of each UTC week and month                         |
| [disk-space-retention](disk-space-retention.md)                     | Retention follows free disk space, and keeps summaries longest                 |
| [summary-backups](summary-backups.md)                               | Backups hold the summaries of a period, and a restore writes summary-only days |

## Access

| ADR                                                                             | Decision                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [one-time-token-admin-api](one-time-token-admin-api.md)                         | The private API takes one-time tokens signed with a key                 |
| [key-rotation](key-rotation.md)                                                 | The key changes with a command on the VPS, and the server does not stop |
| [separate-admin-port](separate-admin-port.md)                                   | The private API has its own port                                        |
| [security-headers](security-headers.md)                                         | Every answer carries headers that stop a browser from running it        |
| [json-query-api-in-a-thread](json-query-api-in-a-thread.md)                     | Queries are JSON objects, run one at a time in a query thread           |
| [query-cache-in-memory](query-cache-in-memory.md)                               | The query thread keeps sealed summaries in memory                       |
| [days-on-several-cores](days-on-several-cores.md)                               | The days of a query are read on several cores                           |
| [saved-servers](saved-servers.md)                                               | The client keeps named servers, groups of them, and a default           |
| [several-servers-merged-by-the-client](several-servers-merged-by-the-client.md) | Servers hold separate visits, and the client adds up their answers      |
| [agent-skill-location](agent-skill-location.md)                                 | The agent skill goes to the git repository, or else to the home folder  |
| [console-web-app](console-web-app.md)                                           | The console is an installable web app that calls the servers directly   |
