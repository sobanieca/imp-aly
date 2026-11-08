# Each app accepts records only from its origins

## Context

A script on another site can make the browsers of its visitors send records to the server. These
browsers come from many addresses, so the rate limit per address does not stop them.

CORS headers alone do not stop this. A browser sends a `POST` with a plain text body without a
preflight, and CORS only hides the answer from the script. The server must refuse the request
itself.

One server holds the records of many apps, and each app runs on its own sites. One list for the
server lets each app accept records from the sites of all the other apps.

## Decision

**Each app has a list of browser origins. The server answers `403` to a request to `/collect/<app>`
with an `Origin` header that is not in the list of that app. There is no "every origin" mode.**

- An origin is a scheme, a host and an optional port, with no path. An app has 1 to 32 origins.
- `PUT /apps/<name>` takes `origins`. With `appUrl` and no `origins`, the list is the origin of the
  URL. An uploaded build needs `origins`. `app add --origins` and the console form send the list.
- `apps.json` keeps the list. `refresh` does not change it. `app add` replaces it.
- A request from an allowed origin gets `access-control-allow-origin` with that origin and
  `vary: origin`. A preflight follows the same rule.
- A request to an app that is not registered gets `404`, also a preflight.
- A request without an `Origin` header passes. A browser always sends it with a `POST`, so only a
  client outside a browser omits it.
- The rate limit counts a refused request. The server does not read its body.
- The check does not apply to the admin port. The admin port allows every origin, because a
  one-time token protects each call. See `one-time-token-admin-api.md`.

## Consequences

- A script on another site cannot add records through the browsers of its visitors.
- An app cannot get records from the sites of another app on the same server.
- A new site of an app needs `app add` with the new list. The server does not restart.
- A page that runs on another origin than its build URL, such as a dev server on `localhost`, needs
  an explicit list.
- A client outside a browser can send any `Origin` header. The build file, the record checks and the
  rate limit still protect the endpoint from it.
