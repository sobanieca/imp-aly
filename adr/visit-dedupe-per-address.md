# One visit per page and address in an 8 hour window

## Context

imp starts a new visit at each load of the document. It stores no id in the browser. So a reload, a
new tab, a return from another site or a phone that reloads a tab in the background starts a new
visit. One person who reads one page can count as several visits of that page.

The browser cannot see its public address, and imp keeps no state between loads. The server sees
the client address of each request already, for the rate limit.

## Decision

**The collect endpoint keeps the records of a page from one client address only for the first
visit that opened the page in a window. The window is 8 hours by default.**

- The key is a hash of the app, the client address and the page. The address is the key of the rate
  limit: an IPv4 address, or the `/64` network of an IPv6 address.
- The value is a hash of the first visit and the time of its first record on the page.
- A record of the same visit passes. A record of another visit in the window is dropped. After the
  window, the next visit owns the page.
- The server counts the dropped records as `deduplicated`, in the answer and in the app counts. They
  are not rejected records.
- The check runs after the rate limit and the record checks, before the write-ahead log.
- The hashes use a random key at each start, so a client cannot choose a collision.
- The server keeps the 1,000,000 most recent keys in memory, in two groups like the rate limit. It
  never writes them to the disk.
- `--dedupe <time>` sets the window, up to 7 days. `--dedupe off` stops the check.

## Consequences

- A reload or a new tab no longer adds a visit to a page.
- People who share one address count as one visit of each page in the window. An office network or
  a mobile network with shared addresses gets too low counts.
- The check works per page. A second visit that opens a new page still counts as a visit of that
  page, so the visits of the whole app can be higher than the visits of one page.
- A restart clears the memory, so the first visit of a page after a restart counts again.
- Two servers do not share the memory. `alySink` sends a new visit to a server by the hash of its id,
  so the visits of one address can count once on each server.
