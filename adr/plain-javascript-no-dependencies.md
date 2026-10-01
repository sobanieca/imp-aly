# Plain JavaScript on Deno, with no dependency

## Context

The server is a public endpoint on a VPS that its owner does not watch every day. Each dependency is
code that can change under the server, carry a vulnerability, or stop being maintained. imp and
tunnelr already use Deno and plain JavaScript, so the owner knows that stack. The work of the server
is small: an HTTP endpoint, file writes, an HMAC, an argument parser and a few text formats. The
Deno runtime and the web platform cover all of it.

## Decision

**The server is plain JavaScript on Deno, with no import outside the repo.**

- No `jsr:`, `npm:` or URL import. The argument parser, the path helpers, the logger and the test
  assertions are small modules in the repo.
- The runtime APIs are the only base: `Deno.serve`, `Deno.open`, `Worker`, `crypto.subtle`, `fetch`
  and `Deno.Command`.
- The code has no comments. Names carry the intent, and the docs and the ADRs carry the reasons.
- `deno fmt` and `deno lint` must pass. The format is the format of imp: no semicolons, single
  quotes, 100 columns.

## Consequences

- The binary has no supply chain beyond Deno itself. There is no lock file, because nothing is
  locked.
- The repo owns a few helpers that a library would give. Each one is small and tested.
- Paths use `/` only. The server supports Linux and macOS, not Windows.
