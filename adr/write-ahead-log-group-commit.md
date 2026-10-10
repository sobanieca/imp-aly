# Records go to a write-ahead log before the answer

## Context

The collect endpoint must answer fast, and an answer of `202` must mean that the records survive a
crash. Writing the column files in the request is slow, because one request touches up to ten files,
and many requests arrive at the same time. An answer before any write loses records in a crash.

## Decision

**The HTTP handler appends the accepted records to a write-ahead log, syncs it, and then answers. A
separate worker moves the log into the column files later.**

- One line of the log is one record: `["<app>", "<day>", {record}]`, in JSON. The handler checks the
  record before it writes it, so the log holds only valid records.
- Group commit: all the appends that arrive while a write runs go into the next single write and the
  next single `fdatasync`. The cost of a sync is shared by every request in the group.
- The log is a series of parts, `<16-digit id>.open`. Every 2 seconds, the server closes the current
  part when it holds records, and renames it to `.log`. It also closes a part after the write that
  takes it to 8 MiB or more. The worker reads only `.log` parts. An empty part is deleted, so an
  idle server writes nothing.
- When a write fails, the server cuts the part back to its size before the write and closes it. So a
  torn line can only be the last line of a part, and no later record follows it. When the cut fails
  too, the server closes the part as `<id>-<size>.log`. The worker reads only the first `<size>`
  bytes. So the records before the failed write are stored, and records that a client got `503` for
  are not.
- The server renames a part before it closes the file. When the rename fails, the part stays open
  and the server logs an error. The timer, or the next full part, tries the rename again. A part
  that was cut back takes new records after its records, because its file ends at a full line. A
  part whose cut failed takes no new records. The next write first tries to close it as
  `<id>-<size>.log`, and fails with `503` while that rename fails. So a part with records never
  stays behind as `.open` while the server writes later parts.
- At start, the server renames a leftover `.open` part to `.log`. A torn last line after a crash is
  not valid JSON. The worker skips it, logs a warning, and counts it in `droppedRecords` of
  `GET /status`.
- Part ids grow for ever. The id of a new part is the current time in milliseconds, or one more than
  the last id when that is larger. The worker writes the id of the last stored part to
  `wal/applied`, and the server starts after the largest id in the folder or in that file. The
  server reads them before it starts the worker, so the worker cannot delete the largest part first.
  An id is never used twice, also when the folder is empty. The time keeps the ids larger than the
  stored ones when somebody deletes `wal/`. A day skips a part that it already holds, so an old id
  would lose records. The worker logs such a part.

## Consequences

- An answer of `202` means the records are on the disk. A crash before the answer can leave a stored
  batch that the client counts as failed. The client of imp does not retry, so this does not double
  a record.
- The column files lag the answer by up to 2 seconds plus the work of the worker.
- A full disk makes the write fail, and the server answers `503`.
