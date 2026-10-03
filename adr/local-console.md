# A local console with a web page, on top of the client code

## Context

The client commands print tables. An owner who looks at the numbers every week wants charts, a query
builder and one place to manage the apps, the servers and the backups. The keys of the servers are
in files of the owner, and the client commands sign a one-time token per request. A page in the
browser must not hold a key, and a page of another site must not use the keys.

## Decision

**`imp-aly console` starts a local web server on port 8010 with a JSON API and a page built with
imp. The API calls the servers with the same client code as the CLI.**

- The console listens on `127.0.0.1`, and on `::1` when the machine has it. `--port` changes the
  port.
- The API reads the saved servers and their keys, and signs a one-time token for each call. The key
  never goes to the browser. `GET /api/servers` shows a key file path or "saved key", never the key.
- A query, an app command and a backup go through the same functions as `imp-aly query`,
  `imp-aly app` and `imp-aly backup`. So the console gives the same numbers as the CLI, also for
  several servers.
- Each request must name the console in its `Host` header: `localhost`, `127.0.0.1` or `[::1]` with
  the port. This stops DNS rebinding.
- A request to the API with `Sec-Fetch-Site: cross-site` fails. A `POST`, `PUT` or `DELETE` must
  carry the `Origin` of the console. So a page of another site cannot change a server.
- Every answer carries a strict Content Security Policy, `X-Frame-Options: DENY` and `nosniff`. The
  API answers carry `Cache-Control: no-store`.
- The page is an imp project in `console/`. `imp build` writes it to `console/dist`, and
  `deno compile --include console/dist` puts it into the binary. The console serves `index.html` for
  a path with no file, except under `/chunks/`.
- The page keeps no data on a server. It keeps the chosen servers, app and days, the query draft and
  the saved queries in the storage of the browser.
- The page reads the numbers with ordinary queries. A report sends a few queries, and the server
  answers each one from the daily summaries when it can.

## Consequences

- The console needs the saved servers of `imp-aly add`, or the local server and the default key
  file, like the client commands.
- A person who can open a connection to the port on the machine can use the keys. The console
  listens on the local addresses only. To use it from another machine, forward the port with SSH.
- A report of a long range sends several queries. The server runs one query at a time, so a report
  takes as long as its queries together.
- The build of the binary needs `imp`. CI installs it, builds the page, and checks the page with
  `imp fmt`, `imp lint` and `imp test --unit`.
