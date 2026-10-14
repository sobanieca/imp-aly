# Each connection has limits and deadlines

## Context

A slow client can hold a connection without a request: it opens the socket and sends the request
head one byte at a time (slowloris), sends a body slowly, or reads the answer slowly. Each open
connection costs a file descriptor and some memory. The cap on the requests in progress counts only
requests that the server has read, see `in-flight-request-cap.md`. So it does not stop a client that
never finishes its head. A few addresses can then use all the sockets of the server.

## Decision

**The HTTP layer of the server limits the open connections of each port and of each address, and
puts a deadline on each step of a connection: the TLS handshake, the request head, each body, and
each write of the answer.**

- Each port takes at most `--max-connections` open connections, 4,096 by default. Above this number,
  the server closes a new connection at once.
- One address can hold at most 1/32 of these connections, 128 by default. An IPv6 address counts per
  `/64`, and a `/48` can hold 4 times the share of one address. The address is the address of the
  socket. A trusted proxy with `--ip-header` has no share, because all its clients use its address.
- A TLS handshake must end in 10 seconds.
- A client must send the request line and all its headers in 10 seconds. The head is at most 16 KiB
  and 64 headers, else the server answers `431`. A head that is not complete in time gets `408`.
- An idle keep-alive connection closes after 5 seconds. When half of the connections of a port are
  in use, it closes after 1 second, and the server closes each connection after its answer.
- A connection serves at most 1,000 requests.
- The body of `POST /collect/<app>` must arrive in 5 seconds, and a body of the admin API in 10
  seconds. An upload to `/restore` must send bytes at least every 30 seconds.
- Each write of an answer must make progress in 30 seconds. So a client that does not read its
  answer loses the connection.
- The server reads only HTTP/1.1 and HTTP/1.0. It refuses a request with both a `content-length` and
  a `transfer-encoding`, two different `content-length` headers, a transfer encoding other than
  `chunked`, a folded header, or a header name that is not a token. This stops request smuggling
  through a proxy in front of the server.
- When the server does not read a body, it closes the connection after the answer. Before it closes,
  it reads and drops up to 1 MiB for 2 seconds, so the client gets the answer and not a reset.
- At a stop, the server stops taking connections, closes the idle ones, and gives the requests in
  progress 10 seconds to end.

## Consequences

- A slow client holds a connection for 10 seconds at most before its first request, and 5 seconds
  between requests.
- To hold all the connections of a port, a flood needs at least 32 IPv4 addresses, or 8 IPv6 `/48`
  networks, and must keep them busy.
- Many people behind one address without `--ip-header` share the connections of that address.
- A client must send its request head in one go. All browsers and HTTP libraries do.
- A flood of bytes or of SYN packets still needs a filter in front of the server.
