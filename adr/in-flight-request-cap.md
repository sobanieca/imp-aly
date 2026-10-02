# A cap on the requests in progress

## Context

The rate limit counts per address. A flood from many addresses passes it. Each request in progress
holds memory: a body of up to 64 KiB, and the work of the record checks and of the log. Without a
cap, a flood can use all the memory of the server.

## Decision

**The server works on at most 1,024 requests at one time on each port, and answers `503` with
`retry-after: 5` above this number.**

- The check is the first step of each request, before the rate limit and before the server reads the
  body. The server cancels the body of a refused request.
- The public port and the admin port count separately. So a flood of the public endpoint does not
  block the private API.
- `--max-requests <n>` changes the cap of both ports.
- `GET /status` shows `activeRequests` for each port.

## Consequences

- The memory of the bodies in progress on the public port stays below about 64 MB.
- In a flood, normal clients of the public port get `503` too.
- The cap does not stop a flood of connections or of bytes before the server reads a request. A
  filter in front of the server must do that.
