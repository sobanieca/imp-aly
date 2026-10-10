# A cap on the requests in progress

## Context

The rate limit counts per address. A flood from many addresses passes it. Each request in progress
holds memory: a body of up to 64 KiB, and the work of the record checks and of the log. Without a
cap, a flood can use all the memory of the server. A cap alone is not sufficient: a few addresses
that send their bodies slowly can hold all the places, and then every client gets `503`.

## Decision

**The server works on at most 1,024 requests at one time on each port, and answers `503` with
`retry-after: 5` above this number. One address can hold at most 1/32 of these places, and the
server reads a collect body for at most 5 seconds.**

- The check is the first step of each request, before the rate limit and before the server reads the
  body. The server cancels the body of a refused request.
- The public port and the admin port count separately. So a flood of the public endpoint does not
  block the private API.
- Each address can have at most `--max-requests` / 32 requests in progress on a port, 32 by default.
  Above this number, the server answers `429` with `retry-after: 5`, before the rate limit and
  before it reads the body. An IPv6 address counts per `/64`, and each `/48` can hold 4 times the
  places of one address. The address is the address of the rate limit, see
  `per-address-sliding-rate-limit.md`.
- The server reads the body of `POST /collect/<app>` for at most 5 seconds, then answers `408`. So a
  slow sender keeps its place for 5 seconds at most. The admin port reads a body for at most 10
  seconds.
- `--max-requests <n>` changes the cap of both ports, and so the share of one address.
- `GET /status` shows `activeRequests` for each port.

## Consequences

- The memory of the bodies in progress on the public port stays below about 64 MB.
- To fill the places of the public port, a flood needs at least 32 IPv4 addresses, or 8 IPv6 `/48`
  networks.
- In a flood from many addresses, normal clients of the public port get `503` too.
- Many people behind one address, or a proxy without `--ip-header`, share the places of one address.
- The cap does not stop a flood of connections or of bytes before the server reads a request. A
  filter in front of the server must do that.
