# imp-aly - Console

The console is a web app for imp-aly. It shows the numbers of your apps in charts and tables. It
also registers, reads again and removes apps. It calls your servers directly from the browser. You
can install it on a phone or on a computer.

Open it in one of two ways:

- **On the web**, at `https://sobanieca.github.io/imp-aly/console/`. Click **Install the app** at
  the bottom of the menu. On a phone, the button is in the navigation drawer. The installed console
  opens like an app, and it starts also without a network.
- **On your machine**, with `imp-aly console`. The binary serves the same page on
  `http://localhost:4400`.

```sh
imp-aly console
```

```
imp-aly 0.1.0 - console

To open the console, go to http://localhost:4400

Add your servers and their keys in the page. Press Ctrl+C to stop the console.
```

| Option          | Value                       | Default |
| --------------- | --------------------------- | ------- |
| `--port <port>` | the port of the console     | `4400`  |
| `--debug`       | log more, in the foreground |         |

The browser shows **Install the app** only when it can install the page. Chrome and Edge show their
install dialog. Safari on an iPhone or an iPad has no such dialog, so the button tells you to tap
Share, then "Add to Home Screen". The button does not show in the installed console. It also does
not show when the browser cannot install the page, for example on a page on `http` that is not
`localhost`.

Installation needs a secure page. GitHub Pages serves the console on `https`, so you need no
certificate for the page. A browser treats `http://localhost` as secure too. A page on another
`http` address cannot install, and cannot sign the tokens.

## Add your servers

The console starts with no server. Open **Servers** and click **Add a server**:

| Field                 | Value                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| Name                  | a name for the server, such as `eu-1`                                       |
| URL of the admin port | the address of the admin port, such as `https://analytics.example.com:4410` |
| Key                   | the key of the server, from `~/.secret/imp-aly-key` on the server           |

The console asks the server for its state at once, and tells you when the server does not answer. To
change the URL or the key, use "Change the URL or the key" in the menu of the server. An empty key
keeps the saved key.

The console does not read a server or a key from its address. Type the values in the form.

The menu row **Servers** shows a tag with the name of the server of the chosen app, such as `eu-1`.
An app on more servers shows the first server and the number of the other servers, such as
`eu-1 +2`. A name longer than 10 characters ends with `...`. With no app, the tag names the saved
servers. With no saved server, the row shows no tag. Put the pointer on a short tag to see the full
names of the servers, such as `eu-1, us-2, ap-3`. A screen reader reads them after the name of the
row.

When a server does not answer, refuses the key or answers with a server error, the tag is red. It
shows the number of these servers, such as `1 failed`, and its tooltip names them. Open **Servers**
to see the problem of each server. The tag shows the name again when the server answers.

### Apps and servers

The menu under the logo shows the app of the reports. It lists each app that your servers have
registered. An app on several servers shows one time. Choose another app there to switch. All
reports show one app at a time. On a phone, the menu is in the navigation drawer.

The app decides which servers a report asks:

- A report asks each server that has registered the app, and adds up their answers.
- A server that does not have the app gets no query.

For example, the app `shop` is on `eu-1` and `us-2`, and the app `docs` is on `us-2` only. A report
of `shop` adds up the answers of `eu-1` and `us-2`. A report of `docs` asks only `us-2`.

The console asks all servers for their apps when it opens, and again on "Run the report again". A
server that does not answer shows in a notice, and the list of apps and the reports leave it out. A
server that does not answer in 30 seconds counts as failed. A query can take up to 130 seconds.

To remove an app, use "Remove" on the Registered apps page. The question names each server of the
app, such as "Remove shop from eu-1, us-2?". These servers then stop accepting records of the app.
The stored records stay until the retention removes them. To bring the app back, register it again
with the same name. Its old records are part of its data again.

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
- The form gives the key from its field to the storage of the browser when you save, and then clears
  the field. The key is not in the state of the form, so a debug log of the page does not show it.
  When the save fails, the field keeps the key, so you can try again.
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
and of the CLI are the same. The page keeps your choices in the storage of the browser: the app and
the days.

The local console, `imp-aly console`, listens on the local addresses of the machine only,
`127.0.0.1` and `::1`. It refuses a request that names another host than `localhost`, `127.0.0.1` or
`[::1]` with its port. It serves only the files of the page.

## The bar

The reports have a bar at the top:

| Control      | What it does                                                                           |
| ------------ | -------------------------------------------------------------------------------------- |
| Period (UTC) | a relative period, or a custom range of days. See below.                               |
| Run again    | sends the queries again, and reads the apps again. Use it to see new records of today. |

The period control has two tabs:

- **Relative**: the last 7 days, 30 days, 3 months, 6 months, 1 year or 5 years. The last day is
  today. Each choice shows its days. At midnight UTC, the period moves to the new day, and the
  report runs again.
- **Custom**: any range of days. Choose the first and the last day, then press "Apply". A day is a
  UTC day, as in the queries.

The length of the range sets the size of one bar in the charts:

| Range              | One bar is                                 |
| ------------------ | ------------------------------------------ |
| up to 45 days      | one day                                    |
| 46 to 200 days     | one week. A week starts on Monday, in UTC. |
| more than 200 days | one month                                  |

The first and the last bar can hold a part of a week or a month only.

With a relative period, each total of a report has a change. The change compares the total with the
previous period of the same length, just before this one. The change shows as a word and a colour,
such as "up 8%" or "down 3%", with the total of the previous period. The tables show that total in a
column with the name of the previous period:

| Period        | Previous period   | Its days                       |
| ------------- | ----------------- | ------------------------------ |
| Last 7 days   | Previous 7 days   | the 7 days before the period   |
| Last 30 days  | Previous 30 days  | the 30 days before the period  |
| Last 3 months | Previous 3 months | the 3 months before the period |
| Last 6 months | Previous 6 months | the 6 months before the period |
| Last year     | Previous year     | the year before the period     |
| Last 5 years  | Previous 5 years  | the 5 years before the period  |

"new" means that the previous period has no record. A custom range shows no change and no previous
period.

A report shows a notice when a server does not answer, when the query skips days, or when the app
has different builds or different segments on the servers. See [Queries](query.md#the-answer).

## Reports

| Report   | What it shows                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------ |
| Overview | the visits, page views, outcomes and errors of the app                                           |
| Pages    | how often each page was viewed and used, and the pages that people reach but do not use          |
| Zones    | how often each zone was seen and used on each page, and the zones that people see but do not use |
| Outcomes | how often the visits reached each outcome, and the share of the visits with an outcome           |
| Errors   | the pages with the most errors, and the errors per 100 page views                                |

Each screen has a help button with a question mark next to its title. The help tells what the screen
shows, and what each measure, column and flag of the report counts. So you can read a report without
this page.

A chart of a report shows one column per bar. The column stacks the 10 items with the highest total,
and puts all other items into "Other". Move the pointer over a column to see the counts.

Pages, Zones, Outcomes and Errors have filters under the bar. "Pages" is a tree of the pages of the
app map. A page is under the nearest page whose path starts its path, so `/users/:id/orders` is
under `/users/:id`, and `/users/invites` is under `/users`. Type a part of a path to find pages. The
first click on a page with sub-pages chooses the page and all its sub-pages, and shows a square. The
second click keeps only the page, and shows a check mark. The third click clears it.

A filter of a segment or of the country can take several values. It shows the values that the
records of the range have. A list shows at most the 300 values with the most records. A line under a
cut list says so. In a cut list of the outcomes, a segment or the country, type another value and
press Enter. "Clear the filters" removes all the filters.

The current day is not sealed. So a report always reads its records, and a long day can make the
report slower. See [Storage](storage.md).

### Overview

Overview shows the app of the menu under the logo. The tiles show the visits, the page views, the
share of the visits with an outcome and the errors per 100 page views. The chart shows the visits.
The tables show the 5 pages with the most views and the 5 outcomes with the highest count. The table
of the pages does not show the home page `/`, because most visits open it.

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

With no page chosen, the chart shows the uses of the top 10 pages. With pages chosen in "Pages", the
whole report shows only those pages:

- With one page, the chart shows the views that used the page, and the views that did not use it.
  The report shows no table.
- With two or more pages, the chart shows the uses of each chosen page. One table shows the chosen
  pages. The tile of the pages that were never reached or used does not show.

The other filters are the segments of the app and the country. They apply to the tables and to the
chart.

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

When the app has more outcomes, a line over the table tells how many outcomes it shows of all.

Choose one or more outcomes in "Outcomes" to see only those outcomes in the table and in the chart.
A chosen outcome with no records shows a count of 0. The other filters are the pages and the
segments.

The tiles show the count of all outcomes, the share of the visits with an outcome, and the most
reached outcome. The share is the visits with an `outcome` record, divided by the visits with a
`page` record.

The report does not count the visits of each outcome. That query cannot use the daily summaries and
reads all the records of the range. Use `imp-aly query` for it.

### Errors

The table shows the 10 pages with the most errors, with the page views, the errors per 100 views and
the change. When more pages have errors, a line over the table tells how many pages it shows of all.
The chart shows the errors of the same pages per bar. Choose pages to see those pages only. The
table then shows each chosen page with errors, and the line tells how many chosen pages have no
errors. The other filters are the segments.

One `error` record stands for up to 5 seconds of failures on one page view. The tiles show the
errors, the errors per 100 page views, and the pages of the app map with errors. More errors than in
the previous period show in red.

## Manage

| Page            | What you can do                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered apps | see the apps of all servers, one row per app with its servers. Register an app from a URL, the build file or text, with segments. See the reasons of the rejected records per server. Read the build file again. Remove an app. |
| Servers         | see the servers of the console, and the state of each one: the version, the source id, the free disk space and the problems of the storage. Add, change and remove a server.                                                    |

"Register" registers the app on the servers that you choose, like `imp-aly app add -s a,b`. With one
server, the console registers the app there. See [Apps](apps.md).

The form lists the segments that the apps on your servers declare, with the names of these apps.
Choose a segment from the list, or type a new name. The form checks each name like the server does.
`country` and the other fields of a record are not segments. The server adds the country itself.

"The build comes from" has three tabs: "URL", "File" and "Text". "Register" sends the build of the
chosen tab. A chosen file also shows on the "Text" tab, so you can change it there. The form checks
that the file or the text is a JSON object. When it is not, the form shows the problem on the field
and sends nothing.

"Read the files again" and "Remove" go only to the servers of the row. "Read the files again" goes
to the servers that read the build file from a URL.

The console does not make backups. Make them with `imp-aly backup` on the VPS or on another machine.
See [Backup](backup.md).
