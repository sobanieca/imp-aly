# The console is an installable web app that calls the servers directly

## Context

An owner wants to read the numbers of the apps on a phone, away from the laptop that has the CLI and
the key files. An earlier console was a local web server with a JSON API on top of the client code.
It worked only on the machine with the saved servers, and a phone could not reach it without an SSH
tunnel. The owner also runs several servers, for example one per customer, and wants to switch
between them in the page.

## Decision

**The console is a Progressive Web App built with imp. It keeps the servers and their keys in the
browser, and calls the admin port of each server directly with an imp HTTP client. It signs a
one-time token for each call. GitHub Pages serves it at
`https://sobanieca.github.io/imp-aly/console/`, and `imp-aly console` serves the same page on
localhost.**

- The page is an imp project in `console/`. `imp build --pwa` writes `console/dist` with a manifest,
  the icons and an offline service worker. So a phone can install the page from the browser.
- The menu has a button **Install the app**. The page keeps the `beforeinstallprompt` event of the
  browser and shows the dialog of the browser on a click. Safari on iOS has no such event, so there
  the button tells the steps "Share", then "Add to Home Screen". The installed page hides the
  button.
- CI builds the page a second time with the environment `pages`, which sets
  `IMP_BASEPATH=/imp-aly/console`, and publishes it with the landing page. GitHub Pages answers a
  missing path with the `404.html` of the site, so CI copies the `index.html` of the console there.
  So a deep link or a reload of a console route opens the console.
- `deno compile --include console/dist` puts the page into the binary. `imp-aly console` serves only
  files. It listens on `127.0.0.1` and `::1`, refuses another `Host`, and sends a strict Content
  Security Policy. Its `connect-src` allows `https:` and `http:`, because the page calls the
  servers.
- The page keeps the servers in IndexedDB. An entry holds the name, the URL of the admin port, and
  the key as a `CryptoKey` for HMAC-SHA-256 with `extractable: false`. The browser signs with the
  key, but no script can read the key back, also not a script of this page. The page asks for
  persistent storage, so the browser does not delete the keys under storage pressure.
- One server is the active server. The Servers screen switches it. The bar of a report can also
  choose several servers, and the page adds up their answers.
- The menu under the logo chooses one app for every report and for Explore. The page never mixes the
  numbers of two apps on one screen. A person looks at one product at a time, and two apps have
  different pages, zones and outcomes.
- A report compares with the previous period only for a relative period, such as the last 30 days.
  The previous period of "Last 3 months" is the months -6 to -3. A custom range has no natural
  previous period, so the page shows no change for it.
- One imp HTTP client, `aly.api`, makes every call. Its `onRequest` interceptor signs the method,
  the path with its query string and the SHA-256 of the body, like the CLI. It hashes a file body as
  a stream. The page sends no `x-request-id`, so a call needs only the headers that the admin port
  allows.
- The page imports the modules of `src/` that use no Deno API: `token.js` for the token, `sha256.js`
  for the hash, `query-core.js` for the parser and the merge, and `multi-server.js` for the calls to
  several servers. So the page and the CLI give the same numbers.
- The admin port allows CORS from every origin, see `one-time-token-admin-api.md`. A token, not the
  origin, protects each call.
- The page does not take a server or a key from its address. A key in a link goes into the history
  of the browser, into logs and into chats. The person types the values in the form.
  `deno task
  start` prints the name, the URL and the key of its demo server for that.
- The page has a dark theme and a light theme. Its fonts are IBM Plex Sans, Space Grotesk and
  JetBrains Mono, under the SIL Open Font License. The page serves the font files itself, with their
  licenses in `fonts/`. So the page loads nothing from another site.
- The page keeps the chosen servers, app and days, the query draft and the saved queries in
  `localStorage`. They hold no key.
- The page reads the numbers with ordinary queries. A report sends a few queries, and the server
  answers each one from the daily summaries when it can.

## Consequences

- An installed console on `https` can call only servers with `https`, because a browser blocks an
  `http` call from an `https` page. A server on `127.0.0.1` is the exception. The local console on
  `http://localhost` can call servers with `http`.
- Anybody who can open the page on an unlocked device can use its servers. A script that runs in the
  page can sign requests while it runs, but it cannot copy a key to another device.
- A missing path of the landing site also shows the console, with the status `404`.
- The page and the CLI keep separate lists. A server that the CLI knows must be added to the page
  once, with its key.
- A change to a shared module in `src/` changes the page too. Such a module must not use a Deno API.
- A report of a long range sends several queries. The server runs one query at a time, so a report
  takes as long as its queries together.
- The build of the binary and of the site needs `imp`. CI installs it, builds the page, and checks
  the page with `imp fmt`, `imp lint` and `imp test --unit`.
