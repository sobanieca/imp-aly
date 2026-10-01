# A rate limit per address, in four sliding windows, in memory

## Context

The record checks stop invalid data, but a sender can still send valid records without end. The
limit must allow the normal traffic of an imp app, also for people behind one office address, and it
must cost almost nothing per request.

## Decision

**The server counts the records of each client address in windows of 5 seconds, 1 minute, 1 hour and
24 hours, and answers `429` at once when an address is over a window.**

- A request costs one, plus one for each record after the first. The check runs before the server
  reads the body, so a blocked request costs no parse. When the records of a request take the
  address over a limit, the server answers `429` and stores none of them.
- Each window is a sliding window counter: the count of the current window plus the count of the
  previous window weighed by its overlap. This stops a double burst at the edge of a fixed window.
- The defaults are 200, 1,500, 30,000 and 200,000. One active tab sends about 70 records a minute.
  The options `--limit-5s`, `--limit-1m`, `--limit-1h` and `--limit-24h` change them.
- The counts live in a map of at most 100,000 addresses, in order of last use. The least recent
  address goes first. Nothing is written to disk.
- IPv6 addresses count per `/64`. `--ip-header` reads the address from a proxy header, and takes its
  last entry.

## Consequences

- One address cannot store more than 200,000 records a day.
- A sender with many addresses can pass the limit. The app map and the checks still hold, and the
  disk retention protects the server.
- A restart clears the counts.
