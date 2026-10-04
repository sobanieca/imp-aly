# imp-aly - Storage

The server keeps everything in one data folder. The default is `~/.imp-aly`, and `--data <folder>`
changes it. The records are plain text files, so you can read them with `cat`, `grep` and `wc -l`.

```
~/.imp-aly/
  lock                         <- one server per data folder
  apps.json                    <- the registered apps
  wal/
    0001759363202417.open      <- the write-ahead log that takes new records
    0001759363200412.log       <- a closed part that waits for the storage worker
    applied                    <- the last part that the storage worker stored
    held/                      <- records of a day that the worker cannot store now
  apps/
    myapp/
      2026-09-28/
        sealed-3/              <- a day that ended more than 1 hour ago: sorted
          meta.json
          type.rle             <- runs: a count and a value per line
          page.rle
          at.txt               <- plain lines, for a field whose values seldom repeat
          summary-counts.tsv   <- the daily summary that most queries read
          summary-tuples.tsv
          summary-visits.tsv
          ...
      2026-09-01/
        sealed-2/              <- a summary-only day: the records are removed
          meta.json
          summary-counts.tsv
          summary-tuples.tsv
          summary-visits.tsv
      2026-10-01/
        raw-1/                 <- a recent day: one line per record in each file
          commit.json
          type.txt
          visit.txt
          at.txt
          page.txt
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
   seconds, or at 8 MiB, and starts a new one. The id of a part is the time when it starts. The
   storage worker reads only closed parts. When a write fails and the server cannot remove the
   half-written lines, it puts the size of the good lines in the name, such as
   `0001759363200412-8192.log`. The worker then reads only the good lines.
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

When a step fails, the worker cuts each file back to its committed size, and removes the files that
the transaction created. A crash at any step leaves a commit that matches the files up to its sizes.
A reader reads each file only up to its committed size, so a reader never sees half a transaction.

## A day that the worker cannot store

When the worker cannot store the records of one app and day, it keeps them in
`wal/held/<app>/<day>/` and stores the other days. A damaged `commit.json` is one cause. The later
records of that day go to the same folder, so they stay in order.

Once a minute, the worker tries the kept records again. When it can store them all, it deletes the
folder. `imp-aly status` names each day under `heldDays`, with the last error. Fix the cause, and
the worker stores the records within a minute.

When the worker cannot read a log part 3 times, it renames the part to `<part>.unreadable` and
continues. `imp-aly status` counts these parts under `unreadableSegments`. The worker never deletes
them. Copy the records that you can read into a new part, or delete the file.

## Each record once

The commit also holds the number of the last log part that it stored. When the worker reads a part a
second time, for example after a crash before it deleted the part, it skips the days that already
hold that part. So a record is stored once.

## Sealed days

A day ends at midnight UTC. The server accepts records with an `at` of up to 1 hour ago, so a day
can still get records for 1 hour after its end. 1 hour and 10 minutes after the end of a day, the
storage worker seals it:

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
     the segments, with the number of records.
   - `summary-tuples.tsv`: each combination of `type`, `page`, `country` and the segments that a
     visit had.
   - `summary-visits.tsv`: the visits, as a count and a list of tuple numbers. Visits with the same
     list share one line.

   Most queries read only these files. See [Queries](query.md).
5. It renames the folder to `sealed-<n>/`, and deletes the raw files of the day.

The sort puts equal values next to each other, so most files shrink to a few lines. A record that
arrives for a sealed day goes to a new `raw-<n+1>/` folder. Queries read it with the sealed data,
and the worker seals the day again later.

Sealing sorts the day in chunks of 250,000 records. It writes each sorted chunk to temporary files
in `sealed-<n>.tmp/`, and then merges the chunks into the run files. So the memory of a seal does
not grow with the size of the day. A day of 1,000,000 records takes about 15 to 20 seconds. During
that time, new records wait in the write-ahead log, and the answers to the apps do not wait.

## Retention

The server never removes data by age. It removes data when the disk needs space. Every minute the
storage worker checks the free space of the disk that holds the data folder. When the free space is
below the minimum, it frees space in three steps, and stops as soon as the free space is enough:

1. **It removes the records of the oldest days, and keeps their daily summaries.** It takes the
   oldest day first, one app at a time. The day becomes a summary-only day. It skips a day that has
   no summary, because the day is not sealed yet.
2. **It removes the oldest days that still hold records.** These are the days that step 1 skipped.
3. **It removes the oldest summary-only days.** It does this only when no day with records is left,
   except the current day.

It never removes the current day.

```sh
sudo imp-aly server --port 2980 --min-free 10%
sudo imp-aly server --port 2980 --min-free 5GB
```

A summary-only day is about 2 MB for 1,000,000 records, and the records of such a day are much
larger. So the history of the summaries is much longer than the history of the records. A query of a
summary-only day reads its summary. A query that needs the records skips the day, and names it in
`skippedDays`. See [Backup](backup.md#a-summary-only-day).

The default is `10%` of the disk. When only the current day is left and the disk is still too full,
the server logs a warning. When the disk is full, the server answers `503` to new records.

The check of the free space runs before the storing and the sealing, and an error in them does not
stop it. So a full disk always gets space back. A day that the worker cannot seal stays raw, and the
worker logs the error and seals the other days.

The check uses `df`, which every Linux and macOS system has. `imp-aly status` shows the last result.

## Back up the data

`imp-aly backup` saves the daily summaries of the sealed days in one compressed file, and
`imp-aly restore` puts them back. To keep the records too, copy the whole data folder. See
[Backup](backup.md).

## Move the data

Stop the server, move the folder, and start the server with `--data <new folder>`.
