# imp-aly - Introduction

This page tells you what imp-aly is, what its key words mean, and how it works. It does not tell you
how to install or run it. For that, read [Getting started](getting-started.md).

## What imp-aly is

An imp app tells you what its users do. Each time a user opens a screen, sees a part of a screen,
clicks or completes a task, the app makes a small record. The `imp/analytics` module gives these
records to a function of your app, the sink. imp-aly is the server that the sink sends the records
to.

imp-aly does three things:

1. It accepts the records of your apps, and drops the records that are not correct.
2. It stores the records on the disk of your server.
3. It answers questions about the records, such as "how many visits did each page get last month".

imp-aly is one file. It needs no database and no other service. You run it on your own VPS, so the
data stays on your machine.

## The big picture

```
 browser                         imp-aly server
+-----------+   POST /collect   +-----------------------------------------------+
| imp app   | ----------------> | checks -> write-ahead log -> storage worker   |
|  + sink   |    records        |                                  |            |
+-----------+                   |                                  v            |
                                |                         column files per day  |
 you                            |                                  |            |
+-----------+   imp-aly query   |                                  v            |
| terminal  | ----------------> | query worker <------- daily summaries         |
+-----------+   (key + token)   +-----------------------------------------------+
```

The left side is public: any browser can send records. The right side is private: only a person with
the key can register apps and run queries.

## Key words

### The app and its records

- **App** - one imp app that you register on the server, such as `myapp`. The server keeps the data
  of each app apart. The app sends its records to `/collect/<app>`.
- **App map** - the file `app-map.txt` that `imp build` writes. It has one line for each screen of
  the app, such as `/invoices/:id`. The server accepts a record only when its page is a line of the
  app map.
- **Record** - one fact about the use of the app, as a small JSON object. For example: "visit `a1b2`
  opened the page `/invoices` at 10:42:07".
- **Record type** - the kind of fact. There are five types:
  - `page` - a user opened a screen. It also holds `readyMs`, the time the screen took to be ready.
  - `seen` - a user saw a part of a screen.
  - `interaction` - a user was active on a screen, or on a part of it.
  - `outcome` - a user completed a task, such as "invoice sent".
  - `error` - an error occurred on a screen.
- **Visit** - one session of a user in one browser tab. All the records of the session have the same
  `visit` id. The server counts visits, not people.
- **Page** - the screen of a record, as its pattern from the app map, such as `/invoices/:id`. It is
  never the real path, such as `/invoices/42`.
- **Zone** - a named part of a screen, such as `myapp.invoice-list`. The `seen` and `interaction`
  records use it.
- **Name** - the name of the task of an `outcome` record, such as `myapp.send`.
- **at** - the time of a record, in milliseconds since 1970, in UTC.
- **Segment** - an extra field that your sink adds to each record, to describe a group of users.
  Examples are the plan, the role or the language. You declare the segments of an app when you
  register it. The server rejects a record with a field that you did not declare. A segment is a
  group, never a person: do not put a user id or an email address in it.
- **Country** - the two-letter country code of a record, such as `PL`. The server takes it from a
  header of your CDN or proxy, when you turn this on.
- **Sink** - the function in your app that gets the records from `imp/analytics` and sends them to
  the server, in batches of up to 64 KiB.

### The way in

- **Collect endpoint** - `POST /collect/<app>`, the only public address for records. It needs no
  key.
- **Checks** - the rules that each record must obey: a known type, a page from the app map, an `at`
  of at most 1 hour from the server time, no unknown field, and more. The server drops a record that
  fails a check, and counts it by reason.
- **Rate limit** - the maximum number of records that one client address can send in 5 seconds, 1
  minute, 1 hour and 24 hours. Above the limit, the server answers `429` and stores nothing.

### The storage

- **Data folder** - the one folder that holds all the data of the server. The default is
  `~/.imp-aly`.
- **Day** - the UTC day of the `at` of a record. The server stores the records of each app in one
  folder per day.
- **Write-ahead log** - a file where the server writes each accepted record first. The server syncs
  the file to the disk before it answers the app. So the records are safe even when the server stops
  a second later.
- **Log part** - the log is a series of small files, the parts. The server closes a part every 2
  seconds and starts a new one. The answer of `imp-aly status` calls the closed parts that wait
  `pendingSegments`. They are not related to the segments of an app.
- **Storage worker** - a background thread that moves the records of each closed log part into the
  column files. It is the only part of the server that writes the column files.
- **Column file** - one file for one field of the records of one app and one day, such as
  `page.txt`. Line N of each column file holds a field of record N. A query opens only the files of
  the fields that it needs.
- **Commit** - the file `commit.json` in each day folder. It holds the number of records and the
  size of each column file. The storage worker adds all the records of a log part, or none of them.
  A crash can never leave a half-written record that a query reads.
- **Raw day** - a day that can still get records, such as the current day. Its column files have one
  line per record, in the order of arrival.
- **Sealed day** - a day that can get no more records. 1 hour and 10 minutes after the end of a day,
  the storage worker seals it: it sorts the records and writes them again in a smaller form.
- **Run file** - the smaller form of a column file in a sealed day. Each line holds a value and the
  number of records in a row that have it, such as `4120 /invoices`. The sort puts equal values next
  to each other, so a run file is short.
- **Daily summary** - small files that the storage worker writes when it seals a day. They hold the
  counts of the day, already added up. Most queries read only the summaries, and so they are fast.
- **Summary-only day** - a day that holds only its daily summary, without its records. A restore
  from a backup makes such a day, and so does the retention.
- **Retention** - the removal of old data. The server does not remove data by age. When the free
  space on the disk goes below a minimum, it removes the records of the oldest days and keeps their
  daily summaries. When that is not enough, it removes the days that have no summary yet, and then
  the oldest summaries. It stops when there is enough space again. The default minimum is 10% of the
  disk.

### The questions

- **Query** - a question about the records of one app, as a JSON object. It names a range of days,
  filters, groups and measures.
- **Dimension** - a field that a query can filter by or group by, such as `page`, `type`, `country`
  or a segment.
- **Measure** - a number that a query calculates for each group, such as `records` (the number of
  records), `visits` (the number of visits) or `readyMs.under:2500` (the percent of page views that
  were ready in less than 2.5 seconds).
- **Scan** - the slow way to answer a query: the server reads the column files of each day. It
  always scans the current day.
- **Query worker** - a background thread that runs the queries, one at a time. A long query does not
  slow down the collection of records.

### Access

- **Key** - a random secret that the server makes when it starts for the first time. It gives access
  to the app registry and to the queries. The key never goes over the network.
- **Token** - a one-time pass that the `imp-aly` command makes from the key for each call. It is
  signed for one request: one method, one path and one body. The server accepts each token once, and
  for 60 seconds at most.

## How it works, step by step

1. **You register an app.** You give the server a name and the app map:
   `imp-aly app add myapp https://myapp.example/app-map.txt`. You can also declare segments.
2. **The app sends records.** The sink of the app collects the records and sends them in a batch to
   `/collect/myapp`.
3. **The server checks the records.** It checks the rate limit of the client address, then each
   record. It drops the records that fail and keeps the rest.
4. **The server writes the log.** It writes the accepted records to the write-ahead log, syncs the
   log to the disk, and answers `202` with the counts of accepted and rejected records.
5. **The storage worker stores the records.** A few seconds later, it moves the records of each
   closed log part into the column files of the app and the day.
6. **The storage worker seals the day.** After the day ends, the worker sorts the records of the
   day, writes the run files and the daily summary, and deletes the raw files.
7. **You ask a question.** You run `imp-aly query` with a JSON query. For each sealed day, the
   server reads the daily summary. For the other days, it scans the column files. Both ways give the
   same result. With several servers, `imp-aly query -s a,b,c` asks each server and adds up the
   answers.
8. **The server makes space.** Every minute, the storage worker checks the free disk space. When it
   is too low, the worker removes the records of the oldest days, and keeps their summaries.

## Next

- [Getting started](getting-started.md) - install the server, register an app, send records
- [Collecting records](collect.md) - the public endpoint, the checks and the rate limit
- [Apps](apps.md) - the registry, the app map and the segments
- [Queries](query.md) - the query API, and queries of several servers
- [Storage](storage.md) - the data folder, sealing and retention in detail
- [Backup](backup.md) - save the daily summaries, restore them, and keep them safe
- [Security](security.md) - the key, the tokens and the limits
- [CLI](cli.md) - every command and option
