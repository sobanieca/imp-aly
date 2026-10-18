# imp-aly - Backup

A backup of imp-aly holds the summaries of a server: one summary for each sealed day, UTC week or
UTC month. A summary is small, and a backup file is compressed. So you can keep years of history on
another disk or another machine. You can restore the summaries into any imp-aly server, and the
server answers most queries from them.

```sh
ssh myvps
sudo imp-aly backup imp-aly-2026-09.tar.gz --last 30d
sudo imp-aly restore imp-aly-2026-09.tar.gz
```

Make and restore backups with the CLI: on the VPS over SSH, or on another machine. The console does
not make backups. See [Back up on the VPS](#back-up-on-the-vps).

You choose three things for a backup:

- **The server.** The backup holds all the apps and all the sources of that server.
- **The period.** The period ends at the last sealed day: the last day, 7 days, 30 days, 3 months, 6
  months, 1 year, or all the days.
- **The granularity.** `day`, `week` or `month`: one summary for each day, UTC week or UTC month.

## What a backup holds

A backup with the granularity `day` holds the daily summary of each sealed day in the period, of
each app and each source. A source is the server that received the records, see
[Storage](storage.md#sources). The summary has the number of records per combination of `type`,
`page`, `zone`, `name`, `country` and the segments, and the pages and types of each visit. See
[Storage](storage.md).

A backup with the granularity `week` or `month` holds the week or month summaries that the server
stores. A week is Monday to Sunday, UTC. See [Storage](storage.md#week-and-month-summaries). A week
or a month is in the backup only when:

- It is complete. The server makes the summary of a week or a month at 01:10 UTC of the day after
  its last day.
- All its days are in the period. A week or a month that starts before the period is not in the
  backup.
- Its summary is current. A late record makes a summary out of date until the next seal.

The server makes week and month summaries only of its own source. A source from a restore of daily
summaries has no week or month summaries, so a `week` or `month` backup does not hold it. Make a
`day` backup to keep such a source. The server does not make summaries during a backup.

A week or a month summary has about the size of one to three daily summaries. So a `month` backup of
a year is much smaller than a `day` backup of the same year. A restored week answers a query by
`week` or with no time. A restored month answers a query by `month` or with no time. A query by
`day` skips them.

A backup does not hold:

- **The column files of the records.** A summary has no `visit` id and no `at` time.
- **The current day, and a day that is not sealed.** The server seals a day at 01:10 UTC of the next
  day. A sealed day that got late records is in the next backup after the server seals it again.
- **A week or a month that is not complete.** The current week and the current month are never in a
  backup.
- **The app registry and the key.** Copy `apps.json` from the data folder and the key file yourself.
  See [Keep the registry and the key](#keep-the-registry-and-the-key).

A daily summary of 1,000,000 records is about 2 MB before compression. The backup file is a tar
archive, compressed with gzip. You can open it with `tar`:

```sh
tar tzf imp-aly-2026-09.tar.gz
```

```
myapp/3f9a0c41d27b6e58/days/2026-09-01/summary-counts.tsv
myapp/3f9a0c41d27b6e58/days/2026-09-01/summary-tuples.tsv
myapp/3f9a0c41d27b6e58/days/2026-09-01/summary-visits.tsv
myapp/3f9a0c41d27b6e58/days/2026-09-02/summary-counts.tsv
...
```

The second part of a path is the source id. The third part is `days`, `weeks` or `months`. A week
folder has the date of its Monday, such as `2026-09-28`, and a month folder has the month, such as
`2026-09`. A week or a month folder also has `summary-days.tsv`, the days of the period with their
number of records. A server that holds a restored backup of another server also puts the summaries
of that source into its own backups.

## Make a backup

```sh
imp-aly backup [<file>] [--last <period>] [--by <granularity>] [-s <name>]
```

| Option               | Value                                        | Default                                                 |
| -------------------- | -------------------------------------------- | ------------------------------------------------------- |
| `<file>`             | the backup file to write                     | `imp-aly-backup-<period>-by-<granularity>-<day>.tar.gz` |
| `--last <period>`    | `1d`, `7d`, `30d`, `3m`, `6m`, `1y` or `all` | `all`                                                   |
| `--by <granularity>` | `day`, `week` or `month`                     | `day`                                                   |
| `-s <name>`          | a saved server                               | the default                                             |
| `--url <url>`        | the URL of the server                        | the local server                                        |
| `-a`, `--auth`       | the key, or a file with it                   | the key file of the local server                        |

The period ends at the last sealed day. `--last 1d` is the last sealed day. `--last 7d` is that day
and the 6 days before it. `--last 3m` starts on the day after the same day 3 months before. For
example:

```sh
imp-aly backup day.tar.gz --last 1d
imp-aly backup weeks.tar.gz --last 3m --by week
imp-aly backup months.tar.gz --last 1y --by month -s eu
```

The server makes the backup while it runs. It does not stop the collection of records. The command
writes the file under a temporary name, reads the whole file again to check it, and then renames it
to `<file>`. So a file with the final name is always complete. The command prints the number of
summaries, apps and sources in the file:

```
Saved 30 daily summaries of 2 apps and 1 source to imp-aly-2026-09.tar.gz (5.8 MB)
```

The command calls the API like `imp-aly query`. So you can run it on another machine with a saved
server, or with `--url` and `-a`. The file goes directly to that machine.

## Back up on the VPS

On the VPS, the commands need no server option. They call the local service:

```sh
ssh myvps
sudo imp-aly backup
```

```
Saved 45 daily summaries of 2 apps and 1 source to imp-aly-backup-all-by-day-2026-10-09.tar.gz (8.1 MB)
```

The command reads the admin port, the bind address and the key file from the unit file of the
service, `/etc/systemd/system/imp-aly.service`. Only root can read the key file of the service, so
use `sudo`. The file goes to the current folder. Copy it from the VPS to another machine:

```sh
scp myvps:imp-aly-backup-all-by-day-2026-10-09.tar.gz .
```

To restore, copy the file to the VPS, then send it to the local service:

```sh
scp imp-aly-backup-all-by-day-2026-10-09.tar.gz myvps:
ssh myvps
sudo imp-aly restore imp-aly-backup-all-by-day-2026-10-09.tar.gz
```

When root has a saved default server or group, the command calls it instead of the local service.
Then give `--url` and `-a` for the local service. When the service uses TLS, give
`--url https://<host in the certificate>:<admin port>`, because the certificate does not name
`127.0.0.1`.

## Restore a backup

```sh
imp-aly restore <file>
```

The command sends the file to the server. The server:

1. Reads the whole file and checks each summary. When a part of the file is not valid, the server
   restores nothing and answers with the problem.
2. Skips each day, week or month of a source that it already stores. The data of the server is
   complete, and a summary is not.
3. Skips each day that it does not seal yet, such as the current day, and each week or month that is
   not complete.
4. Writes each other summary into the folder of its source. A query reads these summaries at once.

The command prints the restored and the skipped summaries:

```
Restored 28 summaries. Skipped 2.

app     day          source             reason
myapp   2026-09-29   3f9a0c41d27b6e58   the server already stores the day of the source
myapp   2026-09-30   3f9a0c41d27b6e58   the server already stores the day of the source
```

You can restore the same file again. The second restore skips each summary.

You can restore the backups of several servers into one server. Each server has its own source, so
the summaries of the servers do not collide. A query then gives the same numbers as a query of the
servers together. This is also true for `week` and `month` backups. See
[Storage](storage.md#move-from-several-servers-to-one-server).

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
day and its source under `skippedDays`, and `imp-aly query` prints them:

```
Skipped 2 days that the query cannot read:
day          source             reason
2026-09-01   3f9a0c41d27b6e58   only the daily summary of the day is stored
2026-09-02   3f9a0c41d27b6e58   only the daily summary of the day is stored
```

When a day has two sources, the query skips only the source that holds only a summary. It counts the
other source.

A summary-only day gets no new records. The server accepts a record only up to 1 hour after the end
of its day, and a summary-only day is always older. When a record for a summary-only day comes from
the write-ahead log, the server drops it and logs a warning.

When the disk needs space, the retention removes the oldest summary-only days only after it removed
the records of all the other old days. It removes the week and month summaries after all the old
days.

## Missing days

A query counts the days that the server stores in the range. A day with no data adds nothing. With
`groupBy` `day`, a day with no data has no row. `days` in the answer is the number of days with
data.

When the server cannot read a day of a source, for example because a file is missing or damaged, the
query skips that source of the day and counts the others. The answer lists the day, the source and
the problem under `skippedDays`. To repair the day, delete the folder of the source in the folder of
the day, and restore the day from a backup.

## Best practices

### Back up each day

Make a backup of the last day, each day. A sealed day does not change, so one backup of each day is
enough. Put this script in `/etc/cron.daily/imp-aly-backup`, and make it executable:

```sh
#!/bin/sh
set -e
day=$(date -u -d '1510 minutes ago' +%F)
mkdir -p /var/backups/imp-aly
imp-aly backup "/var/backups/imp-aly/$day.tar.gz" --last 1d
```

cron runs the script as root, so the command finds the local service and its key file. `--last 1d`
is the last sealed day. The server seals a day at 01:10 UTC of the next day, so the last sealed day
is the day of 25 hours and 10 minutes ago. The script gives the file the name of that day. On macOS,
use `date -u -v-1510M +%F`.

To keep a long history in small files, also make a backup of the months, once a month:

```sh
imp-aly backup "/var/backups/imp-aly/months-$(date -u +%F).tar.gz" --last 1y --by month
```

Also make a backup of all days before a large change, such as a move to a new server:

```sh
imp-aly backup /var/backups/imp-aly/all-$(date -u +%F).tar.gz
```

### Keep a copy on another machine

A backup on the disk of the server is lost with the disk. Copy each backup to another machine, or
run the backup on the other machine:

```sh
imp-aly backup imp-aly-2026-10-01.tar.gz --last 1d -s myvps
```

### Keep the history after a disk loss

The retention keeps the summaries on the disk of the server for a long time. But a summary on that
disk is lost with the disk, and a full disk removes the oldest summaries too. The daily backup keeps
a copy of each summary. To get the history back, restore the backups on the new server.

### Test a restore

A backup that you never restored is not tested. Start a second server on a temporary data folder,
restore a backup into it, and run a query:

```sh
imp-aly server --foreground -p 4410 -d /tmp/imp-aly-test &
imp-aly restore imp-aly-2026-09.tar.gz --url http://127.0.0.1:4410
imp-aly query '{"app": "myapp", "from": "2026-09-01", "to": "2026-09-30"}' --url http://127.0.0.1:4410
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
while the server runs.

**A server on a copy has the source id of the first server, and their days mix.** Start a server on
the copy only to replace the first server, after it stops for good. See
[Storage](storage.md#move-the-data). Only the log, `apps.json` and the files of the current day
change often. A sealed day changes only when the server seals it. To get a copy that is complete to
the second, stop the service, copy the folder, and start the service again.

A full copy is much larger than a backup of summaries. For a long history, keep the summaries, and a
full copy of recent days only.

## The API

The commands call these endpoints. Each one needs a token, see [Security](security.md).

| Endpoint        | Body or query                              | Answer                                         |
| --------------- | ------------------------------------------ | ---------------------------------------------- |
| `GET /backup`   | optional `?last=<period>&by=<granularity>` | `200`, the backup file as a stream             |
| `POST /restore` | the backup file, at most 4 GiB             | `200`, `{"restored": [...], "skipped": [...]}` |

`last` and `by` take the values of `--last` and `--by`. `GET /backup` answers `400` for another
option or value. `POST /restore` answers `400` when the file is not a valid backup, and `413` when
it is too large. When the upload sends no byte for 30 seconds, the server stops it and answers
`408`.
