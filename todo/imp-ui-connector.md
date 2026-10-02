# A native imp-aly sink in imp-ui

## Goal

An imp app sends its records to imp-aly with one line of config, and no sink code of its own. The
sink spreads the visits over several imp-aly servers.

## Where

The code is in `../imp-ui`, module `imp/analytics`. This file tracks the work because the rules of
the sink come from imp-aly. See `adr/several-servers-merged-by-the-client.md`.

## What the sink does

- It takes a list of server URLs and the app name, for example
  `impAly({ app: 'myapp', servers: ['https://a1.example', 'https://a2.example'] })`.
- It picks one server at random when the document loads. It sends every record of the visit to that
  server. The visit id of imp is one per document load, so one visit has one server.
- It sends batches to `POST /collect/<app>`, with `fetch` and `keepalive`, and with
  `navigator.sendBeacon` when the page hides. A batch stays below 64 KiB and holds at most 200
  records, the default 5 s rate limit. The server answers `413` to a larger batch.
- When a send fails with a network error or a `5xx`, it changes to another server of the list and
  keeps the new server for the rest of the visit. It does not change the server for a `4xx`.
- It adds the declared segments of the app to each record.
- It keeps nothing in a cookie, `localStorage` or `sessionStorage`. It never sends a user id.

## Open points

- The retry policy: how many times, and how long the sink keeps a failed batch in memory.
- The handling of `429`: wait, or drop the batch.
- A way to give the server list at build time, from the imp config.

## Done when

- `imp/analytics` exports the sink, with tests in imp-ui.
- The imp-ui analytics docs show it, and `docs/query.md#several-servers` in imp-aly points at it.
- A test app sends to two local imp-aly servers, and `imp-aly query -s a,b` gives the same numbers
  as the browser sent.
