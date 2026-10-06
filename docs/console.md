# imp-aly - Console

The console is a web app for imp-aly. It shows the numbers of your apps in charts and tables, and it
does the work of the client commands: queries, apps, backups and restores. It calls your servers
directly from the browser. You can install it on a phone or on a computer.

Open it in one of two ways:

- **On the web**, at `https://sobanieca.github.io/imp-aly/console/`. Click **Install the app** at
  the bottom of the menu. On a phone, the button is in the navigation drawer. The installed console
  opens like an app, and it starts also without a network.
- **On your machine**, with `imp-aly console`. The binary serves the same page on
  `http://localhost:8010`.

```sh
imp-aly console
```

```
imp-aly 0.1.0 - console

To open the console, go to http://localhost:8010

Add your servers and their keys in the page. Press Ctrl+C to stop the console.
```

| Option          | Value                       | Default |
| --------------- | --------------------------- | ------- |
| `--port <port>` | the port of the console     | `8010`  |
| `--debug`       | log more, in the foreground |         |

The browser shows **Install the app** only when it can install the page. Chrome and Edge show their
install dialog. Safari on an iPhone or an iPad has no such dialog, so the button tells you to tap
Share, then "Add to Home Screen". The button does not show in the installed console.

Installation needs a secure page. GitHub Pages serves the console on `https`, so you need no
certificate for the page. A browser treats `http://localhost` as secure too. A page on another
`http` address cannot install, and cannot sign the tokens.

## Add your servers

The console starts with no server. Open **Servers** and click **Add a server**:

| Field                 | Value                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| Name                  | a name for the server, such as `eu-1`                                       |
| URL of the admin port | the address of the admin port, such as `https://analytics.example.com:2981` |
| Key                   | the key of the server, from `~/.secret/imp-aly-key` on the server           |

The console asks the server for its state at once, and tells you when the server does not answer. A
saved server becomes the active server. To change the URL or the key, use "Change the URL or the
key" in the menu of the server. An empty key keeps the saved key.

To fill the form from a link, open `/servers#name=<name>&url=<url>&key=<key>`. Encode each value for
a URL. The console removes the values from the address and from the history of the browser at once.
Do not send such a link in a chat or in an email, because it holds the key.

### Switch between servers

The menu under the logo shows the active server. Choose another server there to switch. On a phone,
the menu is in the navigation drawer. "Make it the active server" on the Servers page does the same.

To add up the numbers of several servers, choose them in "Servers" in the bar of a report. See
[The bar](#the-bar).

### What the console needs from a server

- **HTTPS on the admin port, for the installed console.** A browser does not let a page on `https`
  call a server on `http`. The console on `http://localhost` can call a server on `http`. A server
  on `127.0.0.1` works from both. See [Security](security.md).
- **An admin port that the device can reach.** The admin port answers the console from every web
  address. The one-time token protects each call. To limit who can connect, use a firewall or a VPN.
- **A clock that agrees with the device to within 60 seconds.** Each token is valid for 60 seconds.

## How the console keeps your keys

- The console keeps each server in the storage of the browser, on this device only. It keeps the key
  in a form that the browser can sign with, but that no script can read back. So nobody can copy the
  key out of the console, and the console cannot show it to you again.
- The console signs a one-time token for each call to a server, like the CLI. The key never goes
  over the network.
- The console asks the browser to keep its storage. A browser that clears the data of the site also
  removes the servers. Add them again with their keys.
- The console and the CLI keep separate lists. A server that you saved with `imp-aly add` is not in
  the console.

**Anybody who can open the console on your device can use your servers.** Lock the device. Remove a
server from the console of a device that you give away.

The console keeps no data on a server. Each report sends queries to the servers. It adds up the
answers of several servers in the same way as `imp-aly query -s a,b`. So the numbers of the console
and of the CLI are the same. The page keeps your choices in the storage of the browser: the servers
of the bar, the app, the days, the query of Explore and the saved queries.

The local console, `imp-aly console`, listens on the local addresses of the machine only,
`127.0.0.1` and `::1`. It refuses a request that names another host than `localhost`, `127.0.0.1` or
`[::1]` with its port. It serves only the files of the page.

## The bar

The reports and Explore have a bar at the top:

| Control         | What it does                                                                           |
| --------------- | -------------------------------------------------------------------------------------- |
| Servers         | the servers to ask. Empty means the active server. More servers add up.                |
| App             | the app of the report. Overview has no app control.                                    |
| Period          | the last 30 days, 3 months, 6 months, 1 year or 5 years. The last day is today.        |
| From - to (UTC) | any range of days. A day is a UTC day, as in the queries.                              |
| Run again       | sends the queries again, and reads the apps again. Use it to see new records of today. |

The bar shows Servers only when the console has two or more servers. It shows App only when the
servers have two or more registered apps.

The length of the range sets the size of one bar in the charts:

| Range              | One bar is                                 |
| ------------------ | ------------------------------------------ |
| up to 45 days      | one day                                    |
| 46 to 200 days     | one week. A week starts on Monday, in UTC. |
| more than 200 days | one month                                  |

The help of a screen tells the size of one bar. The first and the last bar can hold a part of a week
or a month only.

Each total of a report has a change. The change compares the total with the previous period. The
previous period has the same number of days and ends on the day before the first day of the range.
The change shows as a word and a colour, such as "up 8%" or "down 3%". "new" means that the previous
period has no record.

A report shows a notice when a server does not answer, when the query skips days, or when the app
has different builds or different segments on the servers. See [Queries](query.md#the-answer).

## Reports

| Report   | What it shows                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------ |
| Overview | the visits, page views, outcomes and errors of the app, or the visits of each app                |
| Pages    | how often each page was viewed and used, and the pages that people reach but do not use          |
| Zones    | how often each zone was seen and used on each page, and the zones that people see but do not use |
| Outcomes | how often the visits reached each outcome, and the share of the visits with an outcome           |
| Errors   | the pages with the most errors, and the errors per 100 page views                                |

Each screen has a help button with a question mark next to its title. The help tells what the screen
shows, and what each measure, column and flag of the report counts. So you can read a report without
this page.

A chart of a report shows one column per bar. The column stacks the 10 items with the highest total,
and puts all other items into "Other". Move the pointer over a column to see the counts.

Pages, Zones, Outcomes and Errors have filters under the bar. A filter of a segment shows the values
of the segment in the range. "Clear the filters" removes all the filters.

The current day is not sealed. So a report always reads its records, and a long day can make the
report slower. See [Storage](storage.md).

### Overview

With one registered app, Overview shows the app. The tiles show the visits, the page views, the
share of the visits with an outcome and the errors per 100 page views. The chart shows the visits.
The tables show the 5 pages with the most views and the 5 outcomes with the highest count.

With two or more apps, Overview shows all apps. The chart shows the visits of each app, one on top
of the other. Choose the apps on the chart in "Apps on the chart". Empty means all apps. The table
shows each app with its visits, the visits of the previous period, the change and the share of all
visits. The tiles show the visits of all apps, the most visited app and the app with the highest
growth.

### Pages

The tables show each page:

| Column           | What it is                                                                   |
| ---------------- | ---------------------------------------------------------------------------- |
| Views            | the `page` records of the page. One page view sends one.                     |
| Used             | the `used` records with no zone. One page view sends one at most.            |
| Used when viewed | Used divided by Views, in percent: the share of the views that used the page |
| Flag             | "Never reached", "Never used", or "Viewed, rarely used"                      |

A page view is used when the person clicks, taps or types anywhere on the page. You do not declare
zones for this. imp sends the record for every page.

"Never reached" marks a page of the app map with no view. "Viewed, rarely used" marks a page that
was viewed 100 times or more and used in less than 5% of them. The first table shows the 10 most
used pages. The second table shows the 10 least used pages, and every page with no use.

The chart shows the uses of the top 10 pages. Choose a page in "Page on the chart" to see that page
only. The page can be any page of the app map. The chart then shows the views that used the page,
and the views that did not use it. The other filters are the segments of the app and the country.
They apply to the tables and to the chart.

The tiles show the page views and the page uses with their change, the share of the views that used
the page, and the pages that were never reached or never used.

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

| Page            | What you can do                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explore         | run any query of the app. See [Explore](#explore).                                                                                                                                            |
| Registered apps | see the apps of the servers in the bar. Register an app from a URL, the build file or text, with segments. See the reasons of the rejected records. Read the build file again. Remove an app. |
| Servers         | see the servers of the console, and the state of each one: the version, the free disk space and the problems of the storage. Add, change, switch and remove a server.                         |
| Backup          | download a backup of one server, of one app or all apps, and of some days or all days. Restore a backup into a server.                                                                        |

"Register" registers the app on each server of the bar, like `imp-aly app add -s a,b`. See
[Apps](apps.md).

A backup downloads as `imp-aly-backup-<server>-<day>.tar.gz`. It is the same file as the file of
`imp-aly backup`. See [Backup](backup.md).
