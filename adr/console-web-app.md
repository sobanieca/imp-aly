# The console is an installable web app that calls the servers directly

## Context

An owner wants to read the numbers of the apps on a phone, away from the laptop that has the CLI and
the key files. An earlier console was a local web server with a JSON API on top of the client code.
It worked only on the machine with the saved servers, and a phone could not reach it without an SSH
tunnel. The owner also runs several servers, for example one per region, and thinks in apps, not in
servers. A choice of servers on each report was one more control that could ask the wrong servers.

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
  button. The page counts as installed when `navigator.standalone` is true, or when the display mode
  is `standalone`, `minimal-ui` or `window-controls-overlay`. A page that is not a secure context
  cannot install, so it hides the button too.
- CI builds the page a second time with the environment `pages`, which sets
  `IMP_BASEPATH=/imp-aly/console`, and publishes it with the site. `cargo site` builds it with the
  environment `site`, which sets `IMP_BASEPATH=/console` for the local copy of the site. GitHub
  Pages answers a missing path with the `404.html` of the site, so the build copies the
  `index.html` of the console there.
  So a deep link or a reload of a console route opens the console.
- The build of the binary embeds the files of `console/dist`, so the binary holds the page.
  `imp-aly console` serves only files. It listens on `127.0.0.1` and `::1`, refuses another `Host`,
  and sends a strict Content Security Policy. Its `connect-src` allows `https:` and `http:`, because
  the page calls the servers.
- The page keeps the servers in IndexedDB. An entry holds the name, the URL of the admin port, and
  the key as a `CryptoKey` for HMAC-SHA-256 with `extractable: false`. The browser signs with the
  key, but no script can read the key back, also not a script of this page. The page asks for
  persistent storage, so the browser does not delete the keys under storage pressure.
- **The app decides the servers.** The page asks every saved server for its apps with `GET /apps`.
  The menu under the logo lists each app name one time, with no server name. A report asks only the
  servers that registered the app, and adds up their answers with `multi-server.js`. A report has no
  choice of servers.
- A server that does not answer the list of apps or a query shows as failed in a notice. The other
  servers still answer. The page also keeps the last result of each server: no answer, a timeout, a
  reply that is not JSON, `401`, `403` and a `5xx` status are a connection problem, and every other
  answer clears it. The nav row **Servers** then shows a red tag with the number of servers with a
  problem, such as "1 failed". Otherwise the tag names the first server of the chosen app, cut to 10
  characters, with the number of its other servers, such as "eu-1 +2". The text says the state, so
  the tag does not depend on its colour. When the text is short for more, the tag has a title with
  the full names of the servers, such as "eu-1, us-2, ap-3". The title is the tooltip of the tag,
  and a screen reader reads it as the description of the row. Each call has a timeout: 130 seconds
  for a query, 30 seconds for the other calls. A reply that is not JSON, or not a query answer, also
  fails that server only.
- The Registered apps screen shows one row per app, with its servers. An action on a row goes only
  to the servers of that row. The question before a remove names them, such as "Remove shop from
  eu-1, us-2?". "Register" goes to the servers that the person chooses in the form.
- The menu under the logo chooses one app for every report. The page never mixes the numbers of two
  apps on one screen. A person looks at one product at a time, and two apps have different pages,
  zones and outcomes.
- The page has no query builder and no backup screen. `imp-aly query` runs any query, and
  `imp-aly backup` and `imp-aly restore` run on the VPS or on another machine.
- A report compares with the previous period only for a relative period, such as the last 30 days.
  The previous period of "Last 3 months" is "Previous 3 months", the 3 months before them. The page
  names a period in words, not with negative offsets such as "-6 to -3". A custom range has no
  natural previous period, so the page shows no change for it.
- A relative period ends today, as a UTC day. The page stores the name of the period, not its days.
  At midnight UTC, the period moves to the new day, and the reports run again. A custom range keeps
  its days.
- One imp HTTP client, `aly.api`, makes every call. Its `onRequest` interceptor signs the method,
  the path with its query string and the SHA-256 of the body, like the CLI. The page sends no
  `x-request-id`, so a call needs only the headers that the admin port allows.
- The page has its own JavaScript copies of the shared rules in `console/src/shared/`: `token.js`
  for the token, `sha256.js` for the hash, `query-core.js` for the parser and the merge,
  `multi-server.js` for the calls to several servers, `days.js` for the UTC days, weeks and months,
  and `names.js` for the names. The Rust server and CLI have the same rules. Shared test cases keep
  them equal: `console/test/merge-cases.json` holds merge inputs with their answers, and the tests
  of both sides read it. A Rust test checks a token that the JavaScript code signed.
- The admin port allows CORS from every origin, see `one-time-token-admin-api.md`. A token, not the
  origin, protects each call.
- The page does not take a server or a key from its address. A key in a link goes into the history
  of the browser, into logs and into chats. The person types the values in the form. `cargo start`
  prints the name, the URL and the key of its demo server for that.
- The page looks like imp: a top bar with the sections, a column with the pages of a section, and
  the colors of imp. Three color bars sit at the end of the top bar, and a grid with colored
  squares sits in the bottom end corner. A faint grid under the whole page tells the console apart
  from the imp site.
- The page has a light, a dark and a dim theme, and a "System" choice that follows the device. imp
  keeps the choice in `localStorage`. It holds no key. Its fonts are IBM Plex Sans, Space Grotesk and
  JetBrains Mono, under the SIL Open Font License. The page serves the font files itself, with their
  licenses in `fonts/`. So the page loads nothing from another site.
- The key field of the server form is a `textField` with `secret: true`. imp keeps its value out of
  the form state, gives it to `onSubmit`, and clears the field after a successful save. `onSubmit`
  hands the key to `vault.js`. A debug log of the states of imp prints every value of a form, so a
  key in the form state would show in that log.
- The register form lists the segments that the apps on the servers declare, and checks the names
  with the rules of `names.js`, like the server.
- The register form checks that the build file or its text is a JSON object before it sends it. The
  problem shows on the field, and the form sends nothing. A chosen file also fills the text, so the
  person can change it on the "Text" tab. "Register" sends the build of the chosen tab. A change of
  the tab forgets the problems of the fields of the other tabs.
- The page keeps the chosen app and days in `localStorage`. They hold no key.
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
- The page treats the same app name on two servers as one app. Two different products on two servers
  must have different names, or their numbers add up.
- An app that only a failed server holds is not in the menu until that server answers again.
- A change to a shared rule must change the Rust code and the JavaScript copy in the same change.
  The shared test cases fail when they differ.
- A report of a long range sends several queries. The server runs one query at a time, so a report
  takes as long as its queries together.
- The build of the binary and of the site needs `imp`. CI installs it, builds the page, and checks
  the page with `imp fmt`, `imp lint` and `imp test --unit`.
