# imp-analytics-server - Storage

The server keeps everything in one data folder. The default is `~/.imp-analytics-server`, and
`--data <folder>` changes it. The records are plain text files, so you can read them with `cat`,
`grep` and `wc -l`.

```
~/.imp-analytics-server/
  lock                         <- one server per data folder
  apps.json                    <- the registered apps
  wal/
    0000000000000042.open      <- the write-ahead log that takes new records
    0000000000000041.log       <- a closed part that waits for the storage worker
    applied                    <- the last part that the storage worker stored
  apps/
    myapp/
      2026-09-28/
        sealed-3/              <- a day that ended more than 24 hours ago: sorted
          meta.json
          type.rle             <- runs: a count and a value per line
          page.rle
          at.txt               <- plain lines, for a field whose values seldom repeat
          summary-counts.tsv   <- the daily summary that most queries read
          summary-tuples.tsv
          summary-visits.tsv
          ...
      2026-10-01/
        raw-1/                 <- a recent day: one line per record in each file
          commit.json
          type.txt
          visit.txt
          at.txt
          page.txt
          readyMs.txt
          zone.txt
          name.txt
          country.txt
          plan.txt
```

## The path of a record

1. **The request.** The server checks the records of a request, then appends the accepted records to
   the write-ahead log. It writes the records of all requests that arrive together in one write, and
   syncs the file to the disk before it answers. So an answer of `202` means that the records are on
   the disk.
2. **The write-ahead log.** The log is a series of parts. The server closes the current part every 2
   seconds, or at 8 MiB, and starts a new one. The storage worker reads only closed parts. When a
   write fails and the server cannot remove the half-written lines, it closes the part as `.bad`.
   The worker never reads a `.bad` part. Look at it, and delete it.
3. **The storage worker.** One worker thread moves each closed part into the column files, then
   deletes the part. It is the only writer of the column files. It runs beside the HTTP server, so
   it never delays an answer.
4. **The column files.** Each field of a record has its own file in the folder of its app and day.
   Line N of every file belongs to record N.

## One file per field

A row file keeps all the fields of a record on one line. A query that counts pages must then read
every field of every record. A column file keeps one field. A query opens only the files of the
fields that it uses, and skips the rest:

```
type.txt   page.txt        country.txt   plan.txt
page       /invoice        PL            pro
page       /invoice/:id    PL            pro
page       /invoice        EN            enterprise
seen       /invoice        PL            free
```

To count the records where `country` is `PL` and `plan` is `pro`, the query reads `country.txt` and
`plan.txt`, marks the lines that match in a list of ones and zeros, and counts. It never opens
`page.txt` or `type.txt`.

An empty line is null. A field that a record does not have, such as `zone` of a `page` record, is an
empty line. The checks of the server make sure that no value contains a line break.

## Every record or none

The rule that line N of every file is record N must never break. If one file gets a line that the
others do not get, every record after it gets the wrong values. So the storage worker writes the
records of a part as one transaction per app and day:

1. It reads `commit.json`. The commit holds the number of records and the committed size of each
   file in bytes.
2. It cuts each file back to its committed size. This removes a tail that a crash left.
3. It appends the new lines to each file, and syncs each file to the disk.
4. It writes a new `commit.json` with the new sizes, and renames it into place. A rename is atomic.

When a step fails, the worker cuts each file back to its committed size, removes the files that the
transaction created, and tries the part again 5 seconds later. A crash at any step leaves a commit
that matches the files up to its sizes. A reader reads each file only up to its committed size, so a
reader never sees half a transaction.

The commit also holds the number of the last log part that it stored. When the worker reads a part a
second time, for example after a crash before it deleted the part, it skips the days that already
hold that part. So a record is stored once.

## Sealed days

A day ends at midnight UTC. The server accepts records with an `at` of up to 24 hours ago, so a day
can still get records for 24 hours after its end. 24 hours and 10 minutes after the end of a day,
the storage worker seals it:

1. It reads all the records of the day.
2. It sorts them by `page`, `type`, `zone`, `name`, `visit` and `at`, and keeps the rows aligned.
3. It writes each field as a run file into `sealed-<n>.tmp/`. A run file writes a value once with
   the number of rows that repeat it:

   ```
   4120	/invoices
   2210	/invoices/:id
   ```

   The number and the value are separated by a tab. An empty value is null. A field whose values
   seldom repeat, such as `at`, gets a plain file with one line per row, because runs of one row
   make the file larger. `meta.json` lists these fields under `plain`.
4. It writes the daily summary into the same folder:
   - `summary-counts.tsv`: one line per combination of `type`, `page`, `zone`, `name`, `country` and
     the segments, with the number of records and the `readyMs` values as `value:count` pairs.
   - `summary-tuples.tsv`: each combination of `type`, `page`, `country` and the segments that a
     visit had.
   - `summary-visits.tsv`: the visits, as a count and a list of tuple numbers. Visits with the same
     list share one line.

   Most queries read only these files. See [Queries](query.md).
5. It renames the folder to `sealed-<n>/`, and deletes the raw files of the day.

The sort puts equal values next to each other, so most files shrink to a few lines. A record that
arrives for a sealed day goes to a new `raw-<n+1>/` folder. Queries read it with the sealed data,
and the worker seals the day again later.

Sealing reads the whole day into memory. It turns each field into a list of numbers once, and sorts,
writes and summarizes from those lists. A day of 1,000,000 records takes about 15 seconds and less
than 200 MB of live memory. On a machine with much free memory, the process can grow larger before
it frees the memory that it no longer uses. During that time, new records wait in the write-ahead
log, and the answers to the apps do not wait.

## Retention

The server never removes data by age. It removes data when the disk needs space. Every minute the
storage worker checks the free space of the disk that holds the data folder. When the free space is
below the minimum, it removes the oldest day of the data, one app at a time, until the free space is
enough again. It never removes the current day.

```sh
sudo imp-analytics-server --port 2980 --min-free 10%
sudo imp-analytics-server --port 2980 --min-free 5GB
```

The default is `10%` of the disk. When only the current day is left and the disk is still too full,
the server logs a warning. When the disk is full, the server answers `503` to new records.

The check of the free space runs before the storing and the sealing, and an error in them does not
stop it. So a full disk always gets space back. A day that the worker cannot seal stays raw, and the
worker logs the error and seals the other days.

The check uses `df`, which every Linux and macOS system has. `imp-analytics-server status` shows the
last result.

## Back up the data

Copy the data folder while the server runs. Only the log, `apps.json` and the files of the current
day change often. A sealed day changes only when the worker seals it. To get a copy that is complete
to the second, stop the service, copy the folder, and start the service again.

## Move the data

Stop the server, move the folder, and start the server with `--data <new folder>`.
