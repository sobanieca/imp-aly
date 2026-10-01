# The day of a record is the UTC day of its `at`

## Context

The data is split into one folder per day. The owner reads the numbers per UTC day, and a record
carries its own time: `at`, the milliseconds since the epoch, which is UTC by definition. A record
belongs to the day when the person used the app, not to the day when the batch reached the server. A
batch that the browser sends at 00:00:03 holds records of the previous day.

A sender can choose any `at`. A record with an `at` far in the past lands in a day that is sealed or
removed. A record with an `at` far in the future creates a day folder that retention never removes,
because retention keeps the current day and everything after it.

## Decision

**The server puts each record in the folder of the UTC day of its `at`. It accepts an `at` from 24
hours before to 1 hour after the time of the server.**

- One request can fill several days. The handler writes each record to the log with its own day.
- The window is a check of the record, like the other checks, see `app-map-record-validation.md`. A
  record outside it is rejected with the reason `at is more than 24 hours old` or
  `at is more
  than 1 hour ahead`.
- Because no record can be older than 24 hours, the storage worker seals a day 24 hours and 10
  minutes after its end, see `sealed-days-sorted-runs.md`. After that, no new record can arrive for
  it.

## Consequences

- A day in a query holds the records of what happened on that UTC day.
- A browser whose clock is wrong by more than the window loses its records. The rejection counts of
  the app show it.
- The current day and the previous day stay raw until the seal. A query of them parses plain lines.
