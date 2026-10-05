# Each app has the file of its build, and each record is checked against it

## Context

The collect endpoint is public. Without checks, a sender can store any path, any zone, any outcome
name, any field and any amount of text. When an app has a map, `imp build` writes
`app-analytics.json` for this case at the root of the build output. It is one JSON object with three
lists:

- `pages` has the route patterns. Every imp record carries a pattern from it in `page`.
- `zones` has the zone names, sorted: every name that the code can give to `zone({ name })`.
- `outcomes` has the outcome names, sorted: every name that the code can give to `track(name)`.

## Decision

**The server stores records only for registered apps, and only records whose fields pass strict
checks, with `page`, `zone` and the outcome `name` in the lists of the build file.**

- An app has a name, the three lists of its build file, and a list of declared segments. A segment
  name must differ from the reserved names and from the other segments in more than the case,
  because the file system of macOS ignores the case of a file name.
- The registry is `apps.json`, written atomically. It holds `appUrl`, `pages`, `zones`, `outcomes`,
  `segments`, `createdAt`, `buildUpdatedAt` and `buildError` of each app. The private API changes
  it, see `one-time-token-admin-api.md`.
- The file comes from a URL or from an upload. `appUrl` is the URL of the folder where the build
  output is served. The server adds a `/` to its path when it has none, and reads
  `app-analytics.json` relative to it. An upload gives the text of the file in `build`. The CLI
  reads it from a build folder.
- One file means one read per refresh. A read is all or nothing: the three lists always come from
  the same build. The server reads the file of a URL at registration and every 10 minutes. When the
  read fails, the server keeps the last lists and records the error in `buildError`.
- The file is at most 3 MiB, with at most 10,000 entries in each list. The server keeps an entry
  that occurs two times once. `pages` has at least one route pattern. `zones` and `outcomes` can be
  empty. A file that is not JSON, a missing list, or an entry that is not a route pattern or a
  namespaced name fails the registration, and the error names the list and the index, such as
  `zones[3]`.
- A record must have a known `type`, only the fields of its type plus the declared segments, and
  values of the right type and size.
- The free text fields take an allowlist of ASCII characters. `zone` and `name` are two or more
  parts with a `.` between them, at most 128 characters. A part has only letters, digits, `-` and
  `_`. imp checks names with the same rule. A segment value is 1 to 64 letters, digits, `.`, `-` or
  `_`. A number or a boolean becomes text first, so `1e+21` and `NaN` fail.
- After the shape checks, `page` must be in `pages`. The `zone` of a `seen` record must be in
  `zones`. The `zone` of a `used` record must be null or in `zones`. The `name` of an `outcome`
  record must be in `outcomes`.
- A rejected record does not stop the other records of its request. The server counts the rejections
  per app and per reason, for up to 50 reasons, in memory.
- The country is not a record field. The server sets it from a header that the owner names.
- `appConfig`, the hash in each query answer, covers the pages, the zones, the outcome names and the
  segments, so the client sees when servers have different builds.

## Consequences

- A sender cannot add invented pages, zones, outcome names, unknown fields, or large text. The
  reports show only names that are in the code of the app.
- A stored value cannot hold HTML, a shell command, a quote, a space, a control character or other
  Unicode text. A tool that prints or shows the data needs no escape step for these fields.
- A segment value cannot be a free text such as a city name with accents. A segment is a group from
  the code of the app, so a short ASCII key is enough.
- A deploy that adds a screen, a zone or an outcome must update the build file on the server, or the
  records of it are rejected. The rejection counts show it.
- An app needs a build with a map. The server cannot take a build file with a list missing.
- The server cannot store a record of an app that sends extra fields. This is on purpose: a field
  that nobody declared is a bug or an attack.
