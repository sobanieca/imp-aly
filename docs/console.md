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

| Control    | What it does                                                                           |
| ---------- | -------------------------------------------------------------------------------------- |
| Servers    | the saved servers to ask. Empty means the default server. More servers add up.         |
| App        | the app of the reports                                                                 |
| Period     | today, or the last 7, 30 or 90 days. The last day is today.                            |
| Days (UTC) | any range of days. A day is a UTC day, as in the queries.                              |
| Run again  | sends the queries again, and reads the apps again. Use it to see new records of today. |

A report shows a notice when a server does not answer, when the query skips days, or when the app
has a different app map or different segments on the servers. See [Queries](query.md#the-answer).

## Reports

| Report   | What it shows                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview | the visits, the page views, the share of fast page views, the ready time p75, the errors and the interactions. The traffic, the speed and the errors per day. The top pages, and the errors per page. |
| Pages    | the views, the visits, the interactions, the outcomes, the errors and the speed of each page. Choose a page to see its zones, its outcomes and its speed per day.                                     |
| Speed    | the share of the page views that were ready in less than 1, 2.5 or 4 seconds. The percentiles p50, p75 and p95 per day. The distribution of the ready time. The speed per country and per page.       |
| Audience | the visits per country, the records per type, and the visits per value of each segment of the app.                                                                                                    |
| Explore  | any query of the app, with a table and a chart of the result.                                                                                                                                         |

A fast page view is a `page` record with a `readyMs` below the limit. The share is the measure
`readyMs.under:<ms>`, see [Queries](query.md).

The current day is not sealed. So a report always reads its records, and a long day can make the
report slower. See [Storage](storage.md).

### Explore

Build a query in one of two ways:

- **Builder.** Choose the fields to group by, the measures and the filters. A filter suggests the
  values that the servers hold in the chosen days. `Rows` is the `limit` of the query.
- **JSON.** Write the query as JSON. A field of the JSON wins over the bar, such as `from` or `app`.

`Examples` loads the queries of the imp report. The result has these tabs:

| Tab          | What it shows                                             |
| ------------ | --------------------------------------------------------- |
| Table        | the rows. Click a column to sort it.                      |
| Chart        | a line per day when the first group is `day`, else bars   |
| Servers      | the days, the summary days and the records of each server |
| Skipped days | the days that the query cannot read, with the reason      |
| CLI          | the same query as an `imp-aly query` command, to copy     |

`CSV` and `JSON` download the result. `Save` keeps the query of the builder under a name, in the
storage of the browser. A saved query runs again with a click.

## Manage

| Page    | What you can do                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apps    | see the apps of the servers in the bar. Register an app from a URL, a file or text, with segments. See the reasons of the rejected records. Read the app map again. Remove an app. |
| Servers | see the saved servers, and the state of each one: the version, the free disk space and the problems of the storage. Save a server. Make a server the default. Remove a server.     |
| Backup  | download a backup of one server, of one app or all apps, and of some days or all days. Restore a backup into a server.                                                             |

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
