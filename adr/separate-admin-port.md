# The private API has its own port

## Context

The public endpoint and the private API used one port. So the private API was on the internet
wherever the public endpoint was. A stranger could try tokens, and the server computed an HMAC for
each try. A flood of the public endpoint also filled the requests in progress, so the owner could
not call `status` during the flood. A firewall cannot close a path, only a port.

## Decision

**The server listens on two ports. The public port, `--port` with default `2980`, serves
`/collect/<app>`. The admin port, `--admin-port` with default `2981`, serves `/apps`, `/query`,
`/status`, `/backup` and `/restore`. Each port answers `404` to the endpoints of the other.**

- Both ports answer `GET /` with the version.
- `--admin-bind <address>` sets the address of the admin port. By default, it is the `--bind`
  address. `--admin-bind 127.0.0.1` keeps the API off the network.
- The two ports must be different. The server does not start when they are the same.
- Both ports use the same TLS certificate. A new certificate restarts both listeners. When the new
  certificate fails, both listeners keep the old one.
- Each port has its own cap of requests in progress. Both ports share the rate limit per address.
- The client commands call `http://127.0.0.1:2981` by default. A saved server holds the URL of its
  admin port.
- The systemd service gets `CAP_NET_BIND_SERVICE` when one of the two ports is below 1024.

## Consequences

- The owner can close the admin port in the firewall and keep the public port open.
- A flood of the public port does not block the private API.
- The owner must open or forward a second port, or use an SSH tunnel, to call the API from another
  machine.
- A proxy in front of the server needs a separate host or route for the admin port.
