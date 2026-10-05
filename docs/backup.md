# imp-aly - Backup

A backup of imp-aly holds the daily summaries of the sealed days. A daily summary is small, and a
backup file is compressed. So you can keep years of history on another disk or another machine. You
can restore the summaries into any imp-aly server, and the server answers most queries from them.

```sh
imp-aly backup imp-aly-2026-09.tar.gz --from 2026-09-01 --to 2026-09-30
imp-aly restore imp-aly-2026-09.tar.gz
```

## What a backup holds

A backup holds the daily summary of each sealed day of each app. The summary has the number of
records per combination of `type`, `page`, `zone`, `name`, `country` and the segments, and the pages
and types of each visit. See [Storage](storage.md).

A backup does not hold:

- **The column files of the records.** A summary has no `visit` id and no `at` time.
- **The current day, and a day that is not sealed.** The server seals a day at 01:10 UTC of the next
  day. A sealed day that got late records is in the next backup after the server seals it again.
- **The app registry and the key.** Copy `apps.json` from the data folder and the key file yourself.
  See [Keep the registry and the key](#keep-the-registry-and-the-key).

A daily summary of 1,000,000 records is about 2 MB before compression. The backup file is a tar
archive, compressed with gzip. You can open it with `tar`:

```sh
tar tzf imp-aly-2026-09.tar.gz
```

```
myapp/2026-09-01/summary-counts.tsv
myapp/2026-09-01/summary-tuples.tsv
myapp/2026-09-01/summary-visits.tsv
myapp/2026-09-02/summary-counts.tsv
...
```

## Make a backup

```sh
imp-aly backup <file> [--app <name>] [--from <day>] [--to <day>]
```

| Option         | Value                       | Default       |
| -------------- | --------------------------- | ------------- |
| `--app <name>` | the app to back up          | all the apps  |
| `--from <day>` | the first day, `YYYY-MM-DD` | the first day |
| `--to <day>`   | the last day, `YYYY-MM-DD`  | the last day  |
| `-s <name>`    | a saved server              | the default   |
| `--url <url>`  | the URL of the server       | local server  |
| `-a`, `--auth` | the key, or a file with it  | the key file  |

The server makes the backup while it runs. It does not stop the collection of records. The command
writes the file under a temporary name, reads the whole file again to check it, and then renames it
to `<file>`. So a file with the final name is always complete. The command prints the number of days
and apps in the file:

```
Saved the daily summaries of 30 days of 2 apps to imp-aly-2026-09.tar.gz (5.8 MB)
```

The command calls the API like `imp-aly query`. So you can run it on another machine with a saved
server, or with `--url` and `-a`. The file goes directly to that machine.

## Restore a backup

```sh
imp-aly restore <file>
```

The command sends the file to the server. The server:

1. Reads the whole file and checks each summary. When a part of the file is not valid, the server
   restores nothing and answers with the problem.
2. Skips each day that it already stores. The data of the server is complete, and a summary is not.
3. Skips each day that it does not seal yet, such as the current day.
4. Writes the summary of each other day into the data folder. A query reads these days at once.

The command prints the restored and the skipped days:

```
Restored 28 days. Skipped 2 days.

app     day          reason
myapp   2026-09-29   the server already stores the day
myapp   2026-09-30   the server already stores the day
```

You can restore the same file again. The second restore skips each day.

The app of a restored day does not have to be registered. Queries read the data of every app in the
data folder. To collect new records of the app, register it.

## A summary-only day

A summary-only day holds only its daily summary. A restore makes such a day. The retention also
makes such a day when the disk needs space: it removes the records of the oldest days, and keeps
their summaries. See [Storage](storage.md#retention).

The server answers a query of a summary-only day from the summary, with the same numbers as the full
day.

Some queries need the records, and the summary cannot answer them:

- a query that names `visit` in `where` or `groupBy`
- a query that counts `visits` and names `zone` or `name`

Such a query skips the summary-only days, and counts the other days. The answer lists each skipped
day under `skippedDays`, and `imp-aly query` prints them:

```
Skipped 2 days that the query cannot read:
day          reason
2026-09-01   only the daily summary of the day is stored
2026-09-02   only the daily summary of the day is stored
```

A summary-only day gets no new records. The server accepts a record only up to 1 hour after the end
of its day, and a summary-only day is always older. When a record for a summary-only day comes from
the write-ahead log, the server drops it and logs a warning.

When the disk needs space, the retention removes the oldest summary-only days only after it removed
the records of all the other old days.

## Missing days

A query counts the days that the server stores in the range. A day with no data adds nothing. With
`groupBy` `day`, a day with no data has no row. `days` in the answer is the number of days with
data.

When the server cannot read a day, for example because a file of the day is missing or damaged, the
query skips that day and counts the others. The answer lists the day and the problem under
`skippedDays`. To repair the day, delete the folder of the day, and restore the day from a backup.

## Best practices

### Back up each day

Make a backup of one day, each day. A sealed day does not change, so one backup of each day is
enough. Put this script in `/etc/cron.daily/imp-aly-backup`, and make it executable:

```sh
#!/bin/sh
set -e
day=$(date -u -d '26 hours ago' +%F)
mkdir -p /var/backups/imp-aly
imp-aly backup "/var/backups/imp-aly/$day.tar.gz" --from "$day" --to "$day"
```

The day of 26 hours ago is always sealed, at any time of the day and in any time zone. On macOS, use
`date -u -v-26H +%F`.

Also make a backup of each month, and of all days before a large change, such as a move to a new
server:

```sh
imp-aly backup /var/backups/imp-aly/all-$(date -u +%F).tar.gz
```

### Keep a copy on another machine

A backup on the disk of the server is lost with the disk. Copy each backup to another machine, or
run the backup on the other machine:

```sh
imp-aly backup imp-aly-2026-10-01.tar.gz --from 2026-10-01 --to 2026-10-01 -s myvps
```

### Keep the history after a disk loss

The retention keeps the summaries on the disk of the server for a long time. But a summary on that
disk is lost with the disk, and a full disk removes the oldest summaries too. The daily backup keeps
a copy of each summary. To get the history back, restore the backups on the new server.

### Test a restore

A backup that you never restored is not tested. Start a second server on a temporary data folder,
restore a backup into it, and run a query:

```sh
imp-aly server --foreground -p 2981 -d /tmp/imp-aly-test &
imp-aly restore imp-aly-2026-09.tar.gz --url http://127.0.0.1:2981
imp-aly query '{"app": "myapp", "from": "2026-09-01", "to": "2026-09-30"}' --url http://127.0.0.1:2981
```

Stop the test server, and delete the folder.

### Keep the registry and the key

Copy these files after each change:

- `apps.json` in the data folder. It holds the registered apps, the lists of their build files and
  their segments. To restore it, stop the server, copy the file back, and start the server.
- The key file, `~/.secret/imp-aly-key` by default. Without the key, the commands cannot call the
  server. Keep the copy of the key in a safe place, because it gives access to the data.

### Protect the backups

A summary has no `visit` id and no `at` time. It holds counts per page, country and segment. When a
group is small, a count can still describe one customer. Give the backup files the same protection
as the data folder.

## A full copy of the data folder

A backup of summaries cannot answer every query. To keep the records too, copy the whole data folder
while the server runs. Only the log, `apps.json` and the files of the current day change often. A
sealed day changes only when the server seals it. To get a copy that is complete to the second, stop
the service, copy the folder, and start the service again.

A full copy is much larger than a backup of summaries. For a long history, keep the summaries, and a
full copy of recent days only.

## The API

The commands call these endpoints. Each one needs a token, see [Security](security.md).

| Endpoint        | Body or query                         | Answer                                         |
| --------------- | ------------------------------------- | ---------------------------------------------- |
| `GET /backup`   | optional `?app=myapp&from=...&to=...` | `200`, the backup file as a stream             |
| `POST /restore` | the backup file, at most 4 GiB        | `200`, `{"restored": [...], "skipped": [...]}` |

`POST /restore` answers `400` when the file is not a valid backup, and `413` when it is too large.
