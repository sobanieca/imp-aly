# imp-aly - Console

The console is a web page for imp-aly. It runs on your machine. It shows the numbers of your apps in
charts and tables, and it does the work of the client commands: queries, apps, servers, backups and
restores.

```sh
imp-aly console
```

```
imp-aly 0.1.0 - console

To open the console, go to http://localhost:8010

The console uses the saved servers and their keys. Press Ctrl+C to stop it.
```

Open the address in a browser. The console runs until you stop it with Ctrl+C.

| Option          | Value                       | Default |
| --------------- | --------------------------- | ------- |
| `--port <port>` | the port of the console     | `8010`  |
| `--debug`       | log more, in the foreground |         |

## What the console uses

The console calls the servers as the client commands do:

- It reads the saved servers of `imp-aly add`, with their keys. Without a saved server, it calls the
  local server, `http://127.0.0.1:2981`, with the key in `~/.secret/imp-aly-key`. See
  [CLI](cli.md#saved-servers).
- It signs a one-time token for each call to a server. The key stays in the console. The page in the
  browser never gets the key.
- It adds up the answers of several servers in the same way as `imp-aly query -s a,b`. So the
  numbers of the console and of the CLI are the same.

The console keeps no data. Each report sends queries to the servers. The page keeps your choices in
the storage of the browser: the servers, the app, the days, the query of Explore and the saved
queries.

**Anybody who can connect to the port of the console can use your keys.** The console listens on the
local addresses of the machine only, `127.0.0.1` and `::1`. Do not forward the port to other
machines or to the internet.

The console also refuses:

- a request that names another host than `localhost`, `127.0.0.1` or `[::1]` with the port of the
  console,
- a request to the API from a page of another site,
- a change, such as a new app or a removed server, that does not come from the page of the console.

To use the console of another machine, forward the port with SSH, such as
`ssh -L 8010:127.0.0.1:8010 my-machine`, and run `imp-aly console` on that machine.

## The bar

The reports and Explore have a bar at the top:

| Control         | What it does                                                                           |
| --------------- | -------------------------------------------------------------------------------------- |
| Servers         | the saved servers to ask. Empty means the default server. More servers add up.         |
| App             | the app of the report. The Apps report has no app control, because it shows all apps.  |
| Period          | the last 30 days, 3 months, 6 months, 1 year or 5 years. The last day is today.        |
| From - to (UTC) | any range of days. A day is a UTC day, as in the queries.                              |
| Run again       | sends the queries again, and reads the apps again. Use it to see new records of today. |

The length of the range sets the size of one bar in the charts:

| Range              | One bar is                                 |
| ------------------ | ------------------------------------------ |
| up to 45 days      | one day                                    |
| 46 to 200 days     | one week. A week starts on Monday, in UTC. |
| more than 200 days | one month                                  |

A note under the bar tells the size of one bar. The first and the last bar can hold a part of a week
or a month only.

Each total of a report has a change. The change compares the total with the previous period. The
previous period has the same number of days and ends on the day before the first day of the range.
The change shows as a word and a colour, such as "up 8%" or "down 3%". "new" means that the previous
period has no record.

A report shows a notice when a server does not answer, when the query skips days, or when the app
has a different app map or different segments on the servers. See [Queries](query.md#the-answer).

## Reports

| Report   | What it shows                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------ |
| Apps     | the visits of each registered app, their change and their share of all visits                    |
| Pages    | the most and the least visited pages of the app, and the pages of the app map with no view       |
| Zones    | how often each zone was seen and used on each page, and the zones that people see but do not use |
| Outcomes | how often the visits reached each outcome, and the share of the visits with an outcome           |
| Errors   | the pages with the most errors, and the errors per 100 page views                                |

A chart of a report shows one column per bar. The column stacks the 10 items with the highest total,
and puts all other items into "Other". Move the pointer over a column to see the counts.

Pages, Zones, Outcomes and Errors have filters under the bar. A filter of a segment shows the values
of the segment in the range. "Clear the filters" removes all the filters.

The current day is not sealed. So a report always reads its records, and a long day can make the
report slower. See [Storage](storage.md).

### Apps

The chart shows the visits of each app, one on top of the other. Choose the apps on the chart in
"Apps on the chart". Empty means all apps. The table shows each app with its visits, the visits of
the previous period, the change and the share of all visits. The tiles show the visits of all apps,
the most visited app and the app with the highest growth.

### Pages

The tables show the 10 pages with the most views, and the 10 pages with the fewest views. A page
view is a `page` record. The least visited pages include every page of the app map with no view,
marked "Never reached".

The chart shows the views of the top 10 pages. Choose a page in "Page on the chart" to see the views
of that page only. The page can be any page of the app map. The other filters are the segments of
the app and the country. They apply to the tables and to the chart.

The tiles show the page views, the pages of the app map with views, and the pages with no view.

### Zones

The tables show each zone on each page:

| Column         | What it is                                                                  |
| -------------- | --------------------------------------------------------------------------- |
| Seen           | the `seen` records of the zone. One page view sends one at most.            |
| Used           | the `used` records of the zone. One page view sends one at most.            |
| Used when seen | Used divided by Seen, in percent: the share of the views that used the zone |
| Flag           | "Never used", or "Seen, rarely used"                                        |

"Seen, rarely used" marks a zone that was seen 100 times or more and used in less than 5% of them.
The first table shows the 10 most used zones. The second table shows the 10 least used zones.

The chart shows the uses of the top 10 zones. One visit can use several zones, so a visit can count
in more than one part of a column. Choose a zone to see that zone only. The chart then shows the
views that used the zone, and the views that saw the zone but did not use it.

The filters are the page, the zone, the segments and the country. The tiles show the uses of all
zones, the most used zone, the number of zones seen, and the number of zones that are seen but
rarely used.

### Outcomes

The table shows the 10 most reached outcomes, with the count, the share of all outcomes, the count
of the previous period and the change. The chart shows the same outcomes per bar.

Choose one or more outcomes in "Outcomes" to see only those outcomes in the table and in the chart.
The other filters are the page and the segments.

The tiles show the count of all outcomes, the share of the visits with an outcome, and the most
reached outcome. The share is the visits with an `outcome` record, divided by the visits with a
`page` record.

The report does not count the visits of each outcome. That query cannot use the daily summaries and
reads all the records of the range. Use Explore or `imp-aly query` for it.

### Errors

The table shows the 10 pages with the most errors, with the page views, the errors per 100 views and
the change. The chart shows the errors of the same pages per bar. Choose a page to see that page
only. The other filters are the segments.

One `error` record stands for up to 5 seconds of failures on one page view. The tiles show the
errors, the errors per 100 page views, and the pages of the app map with errors. More errors than in
the previous period show in red.

## Explore

Explore is in the Manage group of the menu.

Build a query in one of two ways:

- **Builder.** Choose the fields to group by, the measures and the filters. A filter suggests the
  values that the servers hold in the chosen days. `Rows` is the `limit` of the query.
- **JSON.** Write the query as JSON. A field of the JSON wins over the bar, such as `from` or `app`.

Group by one time field at most: `day`, `week` or `month`. A query that counts `visits` and names
`zone` or `name` cannot use the daily summaries. It reads all the records of the range, so it is
slow.

`Examples` loads the queries of the imp report. The result has these tabs:

| Tab          | What it shows                                                                |
| ------------ | ---------------------------------------------------------------------------- |
| Table        | the rows. Click a column to sort it.                                         |
| Chart        | a line over time when the first group is `day`, `week` or `month`, else bars |
| Servers      | the days, the summary days and the records of each server                    |
| Skipped days | the days that the query cannot read, with the reason                         |
| CLI          | the same query as an `imp-aly query` command, to copy                        |

`CSV` and `JSON` download the result. `Save` keeps the query of the builder under a name, in the
storage of the browser. A saved query runs again with a click.

## Manage

| Page            | What you can do                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explore         | run any query of the app. See [Explore](#explore).                                                                                                                                 |
| Registered apps | see the apps of the servers in the bar. Register an app from a URL, a file or text, with segments. See the reasons of the rejected records. Read the app map again. Remove an app. |
| Servers         | see the saved servers, and the state of each one: the version, the free disk space and the problems of the storage. Save a server. Make a server the default. Remove a server.     |
| Backup          | download a backup of one server, of one app or all apps, and of some days or all days. Restore a backup into a server.                                                             |

"Register" registers the app on each server of the bar, like `imp-aly app add -s a,b`. See
[Apps](apps.md).

"Save a server" changes the same list as `imp-aly add`. A key that you type is saved as it is. A
path of a key file is saved as a path. See [CLI](cli.md#saved-servers).

A backup downloads as `imp-aly-backup-<server>-<day>.tar.gz`. It is the same file as the file of
`imp-aly backup`. See [Backup](backup.md).

## The API of the console

The page calls a JSON API on the same port. You do not need it, but you can call it with `curl` on
the same machine. A change must carry the header `Origin: http://localhost:8010`.

| Request                            | What it does                                           |
| ---------------------------------- | ------------------------------------------------------ |
| `GET /api/servers`                 | the saved servers and the default, without the keys    |
| `POST /api/servers`                | `{"name", "url", "auth"}`: save a server, like `add`   |
| `POST /api/servers/<name>/default` | make the server the default, like `use`                |
| `DELETE /api/servers/<name>`       | remove the saved server, like `rm`                     |
| `GET /api/status?server=<name>`    | the state of one server, like `status`                 |
| `GET /api/apps?servers=a,b`        | the apps of the servers, like `app ls`                 |
| `GET /api/apps/<name>?servers=a,b` | one app on each server, like `app show`                |
| `PUT /api/apps/<name>?servers=a,b` | `{"mapUrl"}` or `{"map"}`, and `"segments"`: `app add` |
| `POST /api/apps/<name>/refresh`    | read the app map again, like `app refresh`             |
| `DELETE /api/apps/<name>`          | remove the app, like `app rm`                          |
| `POST /api/query?servers=a,b`      | a query, like `query --json`, with `warnings`          |
| `GET /api/backup?server=<name>`    | a backup, with `app`, `from` and `to`, like `backup`   |
| `POST /api/restore?server=<name>`  | the backup file as the body, like `restore`            |

Without `servers` or `server`, a request goes to the default server. With several servers, the
answer lists the servers that failed in `failedServers`.
