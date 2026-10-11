# imp-aly - Storage

The server keeps everything in one data folder. The default is `~/.imp-aly`, and `--data <folder>`
changes it. The records are plain text files, so you can read them with `cat`, `grep` and `wc -l`.

```
~/.imp-aly/
  lock                         <- one server per data folder
  format.json                  <- the data format, see Updates
  source.json                  <- the source id of this server, see Sources
  apps.json                    <- the registered apps
  wal/
    0001759363202417.open      <- the write-ahead log that takes new records
    0001759363200412.log       <- a closed part that waits for the storage worker
    applied                    <- the last part that the storage worker stored
    held/                      <- records of a day that the worker cannot store now
  apps/
    myapp/
      2026-09-28/
        3f9a0c41d27b6e58/      <- the source: the server that received the records
          sealed-3/            <- a day that ended more than 1 hour ago: sorted
            meta.json
            type.rle           <- runs: a count and a value per line
            page.rle
            at.txt             <- plain lines, for a field whose values seldom repeat
            summary-counts.tsv <- the daily summary that most queries read
            summary-tuples.tsv
            summary-visits.tsv
            ...
        a71c5e0d9b2f4c13/      <- another source, from the backup of another server
          sealed-1/            <- a summary-only day: the records are not here
            meta.json
            summary-counts.tsv
            summary-tuples.tsv
            summary-visits.tsv
      2026-10-01/
        3f9a0c41d27b6e58/
          raw-1/               <- a recent day: one line per record in each file
            commit.json
            type.txt
            visit.txt
            at.txt
            page.txt
            zone.txt
            name.txt
            country.txt
            plan.txt
      weeks/
        2026-09-21/            <- the week from Monday 2026-09-21 to Sunday 2026-09-27
          3f9a0c41d27b6e58/
            sealed-1/          <- the summary of the week of this source
              meta.json
              summary-counts.tsv
              summary-tuples.tsv
              summary-visits.tsv
      months/
        2026-09/
          3f9a0c41d27b6e58/
            sealed-1/          <- the summary of the month of this source
              ...
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
4. **The column files.** Each field of a record has its own file in the folder of its app, its day
   and the source of the server. Line N of every file belongs to record N.

## Sources

When a server starts with a new data folder, it makes a random source id of 16 hex digits. It keeps
the id in `source.json`. `imp-aly status` shows it under `source`.

A day has one folder for each source. The server writes the records that it receives into its own
source. A restore of the backup of another server writes the summaries into the source of that
server. So one server can keep the history of several servers, and their days never collide.

A query reads each source of a day, and adds up the counts. It counts a visit once in each source
and each day. So the answer is the same as the answer of the servers together, see
[Queries](query.md#several-servers).

The server writes and seals only its own source. The folder of another source comes from a restore
or from a copy, and gets no new records.

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

Some records cannot be stored at all:

- A line of a log part that is not a valid record, such as the last line of a part after a crash.
- The records of a day that holds only its daily summary. The retention or a restore can make a day
  a summary while its records wait aside. A summary-only day takes no new records.

The worker drops these records and logs an error. `imp-aly status` counts them under
`droppedRecords`, since the start of the server. The console shows the count on the Servers screen.

## Each record once

The commit also holds the number of the last log part that it stored. When the worker reads a part a
second time, for example after a crash before it deleted the part, it skips the days that already
hold that part. So a record is stored once.

## Sealed days

A day ends at midnight UTC. The server accepts records with an `at` of up to 1 hour ago, so a day
can still get records for 1 hour after its end. 1 hour and 10 minutes after the end of a day, the
storage worker seals the day in its own source:

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

## Week and month summaries

A week is Monday to Sunday, UTC. The name of its folder is the Monday, such as `2026-09-21`. The
name of a month folder is the month, such as `2026-09`.

1 hour and 10 minutes after the end of a week or a month, the storage worker adds up the daily
summaries of its own source in that period. It writes the result as one summary of the period, with
the same three files. `meta.json` lists the days that the summary holds, with the number of records
of each day. The summary of a month of 1,000,000 records a day is about the size of one to three
daily summaries, because most combinations occur each day.

The summary keeps the visits of each day apart. So `visits` of a week is the sum of the visits of
its days, as in a query of the days. See [Queries](query.md#how-a-query-reads-the-data).

When a day of a complete week or month gets late records, the worker seals the day again, and then
makes the summary of the week and the month again. Until then, queries read the days.

The worker makes the week and month summaries only of its own source. The summaries of another
source come from a restore or from a copy.

## Retention

The server never removes data by age. It removes data when the disk needs space. Every minute the
storage worker checks the free space of the disk that holds the data folder. When the free space is
below the minimum, it frees space in five steps, and stops as soon as the free space is enough:

1. **It removes the records of the oldest days, and keeps their daily summaries.** It takes the
   oldest day first, one app at a time, with all the sources of the day. The day becomes a
   summary-only day. It skips a source that has no summary, because the source is not sealed yet.
2. **It removes the oldest days that still hold records.** These are the days that step 1 skipped.
3. **It removes the oldest summary-only days.** It does this only when no day with records is left,
   except the current day.
4. **It removes the oldest week summaries.**
5. **It removes the oldest month summaries.**

It removes a day, a week or a month with all its sources. It never removes the current day.

```sh
sudo imp-aly server --port 2980 --min-free 10%
sudo imp-aly server --port 2980 --min-free 5GB
```

A summary-only day is about 2 MB for 1,000,000 records, and the records of such a day are much
larger. So the history of the summaries is much longer than the history of the records. A query of a
summary-only day reads its summary. A query that needs the records skips the day, and names it in
`skippedDays`. See [Backup](backup.md#a-summary-only-day).

After step 3, a query grouped by `week` or `month` still reads the week and month summaries. A query
grouped by `day` skips the days that only a week or a month summary holds.

The default is `10%` of the disk. When only the current day is left, with no week or month summary,
and the disk is still too full, the server logs a warning. When the disk is full, the server answers
`503` to new records.

The check of the free space runs before the storing and the sealing, and an error in them does not
stop it. So a full disk always gets space back. A day that the worker cannot seal stays raw, and the
worker logs the error and seals the other days.

The check asks the system for the free space of the file system of the data folder. `imp-aly status`
shows the last result.

## Back up the data

`imp-aly backup` saves the daily, week or month summaries of a period in one compressed file, and
`imp-aly restore` puts them back. To keep the records too, copy the whole data folder. See
[Backup](backup.md).

## Move the data

The server keeps all its data in the data folder, and the folder must be on one disk. To get more
space, move the folder to a larger disk. The free space check then uses the new disk.

**Two servers with the same source id mix their days.** A copy of a data folder has the source id of
the old server. A move keeps the id, and that is correct, because you delete the old folder. Do not
run a server on a copy while the server of the old folder still runs or can run again. To start a
new server, give it an empty data folder.

### Move the service to a new folder

These steps move the data of the service to a new disk that is mounted at `/mnt/data`.

1. Read the options of the service on the `ExecStart` line of the unit file:

   ```sh
   grep ExecStart /etc/systemd/system/imp-aly.service
   ```

2. Stop the service, and copy the data folder to the new disk:

   ```sh
   sudo systemctl stop imp-aly
   sudo rsync -a /var/lib/imp-aly/ /mnt/data/imp-aly/
   ```

3. Start the service again with the new folder, and with every option of step 1:

   ```sh
   sudo imp-aly server --data /mnt/data/imp-aly --port 2980 --allow-origin https://myapp.example
   ```

   The command writes the new unit file, makes the user `imp-aly` the owner of the new folder, and
   starts the service.

4. Make sure that the server uses the new folder, and that a query gives the same numbers as before:

   ```sh
   imp-aly status
   ```

5. Delete the old folder when the new folder works.

**The service loses the options that you do not give again.** The command writes the unit file only
from the options of the command. An option that you leave out goes back to its default, such as
`--allow-origin`, `--tls-cert` or `--min-free`. Always copy the options from step 1.

The new folder must not be in `/root`. The user `imp-aly` must be able to open each parent folder of
the new folder. When it cannot, the command stops and changes nothing.

### Mount the new disk at the old folder

You can also keep the path of the data folder, and put the new disk under it. Then the unit file
does not change:

1. Stop the service: `sudo systemctl stop imp-aly`.
2. Copy `/var/lib/imp-aly/` to the new disk.
3. Mount the new disk at `/var/lib/imp-aly`, and add the mount to `/etc/fstab`.
4. Make sure that the user `imp-aly` owns the folder:

   ```sh
   sudo chown -R imp-aly:imp-aly /var/lib/imp-aly
   ```

5. Start the service: `sudo systemctl start imp-aly`.

### Move a server in the foreground

Stop the server, move the folder, and start the server with `--data <new folder>`.

### The minimum free space

A `--min-free` value in percent, such as the default `10%`, applies to the new disk. A larger disk
keeps more free space with the same percent. A value in bytes, such as `5GB`, stays the same.

### Move from several servers to one server

You can stop server B and keep its history on server A. Choose one of these ways.

**Keep the daily summaries.** This way does not stop server A.

1. Remove the URL of server B from the `servers` option of `alySink` in your app, and publish the
   app.
2. Wait until 01:10 UTC of the day after the last records of server B. Server B then seals its days.
3. Make a backup of server B, and restore it into server A:

   ```sh
   imp-aly backup b-all.tar.gz -s b
   imp-aly restore b-all.tar.gz -s a
   ```

4. Stop server B.

Server A writes each day of the backup into the source of server B. A query of server A then gives
the same numbers as a query of the two servers. A query that needs the records skips the days of
server B, see [Backup](backup.md#a-summary-only-day).

**Keep the records.** This way copies the source folders of server B into the data folder of server
A, and stops server A for the copy.

1. Do steps 1 and 2 of the first way. Server A does not seal the source of another server, and a day
   that is not sealed is slower to read.
2. Read the source id of server B under `source`:

   ```sh
   imp-aly status -s b
   ```

3. On server B, stop the service, and pack its source folders. These are the folders of its days,
   weeks and months. Use the source id of step 2:

   ```sh
   sudo systemctl stop imp-aly
   cd /var/lib/imp-aly && sudo find apps -name a71c5e0d9b2f4c13 -prune > /tmp/source-b.txt
   sudo tar czf /tmp/source-b.tar.gz -T /tmp/source-b.txt
   ```

4. Copy `/tmp/source-b.tar.gz` to server A.
5. On server A, stop the service, unpack the file in the data folder, and start the service:

   ```sh
   sudo systemctl stop imp-aly
   cd /var/lib/imp-aly && sudo tar xzf /tmp/source-b.tar.gz
   sudo chown -R imp-aly:imp-aly /var/lib/imp-aly/apps
   sudo systemctl start imp-aly
   ```

6. Make sure that a query of server A gives the same numbers as the query of the two servers before.
   Then delete server B.

**Server A must not hold the source of server B before the copy.** When you restored a backup of
server B into server A before, the copy mixes the two. On server A, delete those folders first:
`sudo find /var/lib/imp-aly/apps -name <source id of B> -prune -exec rm -r {} +`.

To move several servers, do these steps for each server.
