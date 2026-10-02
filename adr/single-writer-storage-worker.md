# One storage worker is the only writer of the data

## Context

The column files, the sealing of a day and the retention all change the data folder. Two writers on
one folder need locks, and a lock bug breaks the alignment of the columns. The HTTP handler must
never wait for that work.

## Decision

**One `Worker` thread does all writes to `apps/`: it stores the log parts, restores backups, seals
the days and removes old days. It does them one after the other.**

- The loop: check the free disk space at most once a minute, store every closed log part in id order
  and delete each part after it is stored, run the waiting restores, then seal the due days at most
  once a minute.
- The free space check comes first and has its own error handling. So an error in the storing or the
  sealing, such as a full disk, never stops the retention that would fix it.
- Each day seals on its own. A day that fails to seal is logged and stays raw, and the other days
  still seal.
- The server wakes the worker when it closes a part. Without a wake-up, the worker checks every
  second.
- When the worker cannot store the records of one app and day, it keeps them aside in
  `wal/held/<app>/<day>/`, one file per log part, and stores the other days of the part. Later parts
  of that day go aside too, so the order stays. Once a minute, the worker tries the kept parts
  again, oldest first. When they are all stored, the day goes back to the normal path.
- When another step fails, such as a full disk, the worker logs the error and tries again in 5
  seconds. When a log part cannot be read 3 times, the worker renames it to `<part>.unreadable` and
  continues. It never deletes such a part.
- When the worker thread dies, the server starts a new one after 5 seconds.
- A `lock` file in the data folder, locked with `flock`, stops a second server on the same folder.

## Consequences

- No lock exists between writers, because there is one writer.
- One broken day folder does not stop the storing of the other days. `imp-aly status` names each day
  with kept records, and the last error of the day.
- Readers need no lock either. They read committed sizes and immutable sealed folders, see
  `append-transaction-with-revert.md`.
- Sealing a large day blocks the storing of new parts for the time of the sort. The log holds the
  records in that time, and the answers do not wait.
