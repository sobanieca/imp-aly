# Plain JavaScript on Deno, with no dependency in the server

## Context

The server is a public endpoint on a VPS that its owner does not watch every day. Each dependency is
code that can change under the server, carry a vulnerability, or stop being maintained. imp and
tunnelr already use Deno and plain JavaScript, so the owner knows that stack. The work of the server
is small: an HTTP endpoint, file writes, an HMAC, an argument parser and a few text formats. The
Deno runtime and the web platform cover all of it.

The console is different. It runs on the machine of the owner, listens on the local addresses only,
and has a router, middleware and a web page with charts. A small framework and a UI toolkit make it
shorter and easier to change. See `local-console.md`.

## Decision

**The server, its workers and the client commands are plain JavaScript on Deno, with no import
outside the repo. Only the console uses two dependencies: Hono for its API, and imp for its page.**

- The modules of the server, the storage, the query engine, the CLI and the tests import nothing
  from outside the repo. The argument parser, the path helpers, the logger and the test assertions
  are small modules in the repo.
- The runtime APIs are the base: `Deno.serve`, `Deno.open`, `Worker`, `crypto.subtle`, `fetch` and
  `Deno.Command`.
- `src/console-api.js` is the only module that imports Hono. The version is exact in the `imports`
  of `deno.json`, and `deno.lock` locks its files.
- The page of the console is an imp project in `console/`. `imp build` makes static files with no
  runtime dependency, and `deno compile` puts them into the binary.
- The code has no comments. Names carry the intent, and the docs and the ADRs carry the reasons.
- `deno fmt` and `deno lint` must pass for the Deno code, and `imp fmt` and `imp lint` for the page.
  The format is the format of imp: no semicolons, single quotes, 100 columns.

## Consequences

- The public endpoint and the storage have no supply chain beyond Deno itself.
- The binary carries Hono and the built page. The build needs network access to JSR once, and the
  `imp` binary to build the page.
- The repo owns a few helpers that a library would give. Each one is small and tested.
- Paths use `/` only. The server supports Linux and macOS, not Windows.
