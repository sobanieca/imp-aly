# The public endpoint can accept only the allowed browser origins

## Context

The collect endpoint allows every origin by default, so an imp app on any site can send records. A
script on another site can also make the browsers of its visitors send records to the server. These
browsers come from many addresses, so the rate limit per address does not stop them.

CORS headers alone do not stop this. A browser sends a `POST` with a plain text body without a
preflight, and CORS only hides the answer from the script. The server must refuse the request
itself.

## Decision

**`imp-aly server --allow-origin <list>` sets the browser origins that can send records. The server
answers `403` to a request to `/collect/<app>` with another `Origin` header.**

- An origin is a scheme, a host and an optional port, with no path. The server checks the list at
  the start.
- A request from an allowed origin gets `access-control-allow-origin` with that origin and
  `vary: origin`. A preflight follows the same rule.
- A request without an `Origin` header passes. A browser always sends it with a `POST`, so only a
  client outside a browser omits it.
- The rate limit counts a refused request. The server does not read its body.
- Without the option, the endpoint answers `access-control-allow-origin: *` and accepts every
  origin.
- The option is one list for the server, not one list for each app.
- The option does not apply to the admin port. The admin port allows every origin, because a
  one-time token protects each call. See `one-time-token-admin-api.md`.

## Consequences

- A script on another site cannot add records through the browsers of its visitors.
- A client outside a browser can send any `Origin` header. The build file, the record checks and the
  rate limit still protect the endpoint from it.
- Each new site of an app needs a change of the option and a restart of the server.
