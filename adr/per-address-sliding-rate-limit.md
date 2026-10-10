# A rate limit per address, in four sliding windows, in memory

## Context

The record checks stop invalid data, but a sender can still send valid records without end. The
limit must allow the normal traffic of an imp app, also for people behind one office address, and it
must cost almost nothing per request. Its memory must stay the same when many addresses send.

## Decision

**The server counts the records of each client address in windows of 5 seconds, 1 minute, 1 hour and
24 hours, and answers `429` at once when an address is over a window.**

- A request costs one, plus one for each record after the first. The check runs before the server
  reads the body, so a blocked request costs no parse. When the records of a request take the
  address over a limit, the server answers `429`, stores none of them and does not count them.
- One request holds at most as many records as the smallest limit. A larger request can never pass,
  so the server answers `413` and does not count its records.
- Each window is a sliding window counter: the count of the current window plus the count of the
  previous window weighed by its overlap. This stops a double burst at the edge of a fixed window.
  The windows start at multiples of their length, the same for all addresses.
- The defaults are 200, 1,500, 30,000 and 200,000. One active tab sends about 70 records a minute.
  The options `--limit-5s`, `--limit-1m`, `--limit-1h` and `--limit-24h` change them.
- IPv6 addresses count per `/64`. Each `/48` also counts, with 16 times the limits. A provider often
  gives one customer a `/48`, which holds 65,536 networks of `/64`.
- The counts of an address are 12 numbers of 32 bits in a typed array. A map gives the slot of each
  address. One address costs about 120 bytes.
- The server keeps two generations of at most 200,000 addresses each. A new address goes into the
  newer generation. A known address in the older generation moves to the newer one. When the newer
  generation is full, the server drops the older one and starts a new one. Each step is O(1).
- `--ip-header` reads the address from a proxy header, and takes its last entry. The server reads
  the header only when the connection comes from `--trusted-proxy`, by default `127.0.0.0/8` and
  `::1`.
- The server parses the entry as an IPv4 address, an IPv4 address with a port (`1.2.3.4:5678`), an
  IPv6 address, or an IPv6 address in brackets with or without a port (`[2001:db8::1]:443`). It
  removes the port and writes the address in one form, also for an IPv4-mapped IPv6 address. So a
  port that a proxy adds does not give each connection its own limit. An entry that is not an
  address counts for the address of the proxy.

## Consequences

- One address cannot store more than 200,000 records a day.
- The memory of the limit stays at about 50 MB, also when millions of addresses send.
- A sender with more than 400,000 addresses can pass the limit, because the server forgets them. The
  cap on requests in progress, the build file, the checks and the disk retention still hold. A
  larger attack needs a filter in front of the server.
- A client that connects directly cannot escape the limit with a false header.
- A restart clears the counts.
