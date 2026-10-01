# Architecture Decision Records

Each ADR captures one architectural decision: the context that forced it, the decision, and the
consequences. Every ADR in this folder is the current, accepted state of that decision. There is no
status field. When a decision changes, replace its ADR. When a decision is dropped, delete its ADR.

- **A file name is a short, descriptive slug of the decision.** There is no number.
- **The format of a record is Context, Decision, Consequences.**
- **Presence means accepted.** The folder reflects what the code does.

## Runtime and distribution

| ADR                                                                     | Decision                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| [plain-javascript-no-dependencies](plain-javascript-no-dependencies.md) | Plain JavaScript on Deno, with no dependency         |
| [single-binary-systemd-service](single-binary-systemd-service.md)       | One binary that installs itself as a systemd service |
| [binary-distribution](binary-distribution.md)                           | Binaries on GitHub Releases, with a checksum         |

## Collection

| ADR                                                                 | Decision                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| [app-map-record-validation](app-map-record-validation.md)           | Records are checked against the app map and strict rules |
| [per-address-sliding-rate-limit](per-address-sliding-rate-limit.md) | A rate limit per address, in four sliding windows        |
| [utc-day-from-record-time](utc-day-from-record-time.md)             | The day of a record is the UTC day of its `at`           |
| [write-ahead-log-group-commit](write-ahead-log-group-commit.md)     | Records go to a synced write-ahead log before the answer |

## Storage

| ADR                                                                 | Decision                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| [single-writer-storage-worker](single-writer-storage-worker.md)     | One storage worker is the only writer of the data      |
| [plain-text-column-files](plain-text-column-files.md)               | Plain text column files, one folder per app and day    |
| [append-transaction-with-revert](append-transaction-with-revert.md) | An append to the columns is a transaction that reverts |
| [sealed-days-sorted-runs](sealed-days-sorted-runs.md)               | A finished day is sorted and stored as runs            |
| [disk-space-retention](disk-space-retention.md)                     | Retention follows free disk space, not age             |

## Access

| ADR                                                         | Decision                                                |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| [one-time-token-admin-api](one-time-token-admin-api.md)     | The private API takes one-time tokens signed with a key |
| [json-query-api-in-a-worker](json-query-api-in-a-worker.md) | Queries are JSON objects, run one at a time in a worker |
