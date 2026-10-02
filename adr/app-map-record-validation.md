# Each app has an app map, and each record is checked against it

## Context

The collect endpoint is public. Without checks, a sender can store any path, any field and any
amount of text. imp builds `app-map.txt` for this case: one route pattern per line, and every imp
record carries a pattern from that file in `page`.

## Decision

**The server stores records only for registered apps, and only records whose fields pass strict
checks, with `page` on the app map.**

- An app has a name, an app map and a list of declared segments. A segment name must differ from the
  reserved names and from the other segments in more than the case, because the file system of macOS
  ignores the case of a file name.
- The registry is `apps.json`, written atomically. The private API changes it, see
  `one-time-token-admin-api.md`.
- The map comes from a URL or from an upload. A URL map is read at registration and every 10
  minutes. A failed read keeps the last map and records the error.
- A record must have a known `type`, only the fields of its type plus the declared segments, and
  values of the right type and size.
- The free text fields take an allowlist of ASCII characters. `zone` and `name` are two or more
  parts with a `.` between them, at most 128 characters. A part has only letters, digits, `-` and
  `_`. imp checks names with the same rule. A segment value is 1 to 64 letters, digits, `.`, `-` or
  `_`. A number or a boolean becomes text first, so `1e+21` and `NaN` fail.
- A rejected record does not stop the other records of its request. The server counts the rejections
  per app and per reason, for up to 50 reasons, in memory.
- The country is not a record field. The server sets it from a header that the owner names.

## Consequences

- A sender cannot add invented pages, unknown fields, or large text.
- A stored value cannot hold HTML, a shell command, a quote, a space, a control character or other
  Unicode text. A tool that prints or shows the data needs no escape step for these fields.
- A segment value cannot be a free text such as a city name with accents. A segment is a group from
  the code of the app, so a short ASCII key is enough.
- A deploy that adds a screen must update the map, or the records of the screen are rejected. The
  rejection counts show it.
- The server cannot store a record of an app that sends extra fields. This is on purpose: a field
  that nobody declared is a bug or an attack.
