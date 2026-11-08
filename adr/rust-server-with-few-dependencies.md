# The server is Rust, with few dependencies

## Context

The server is a public endpoint on a VPS that its owner does not watch every day. Each dependency is
code that can change under the server, carry a vulnerability, or stop being maintained. The work of
the server is small: an HTTP endpoint, file writes, an HMAC, an argument parser and a few text
formats. The first version was plain JavaScript on Deno. A runtime with a JIT and a garbage
collector gave the server little control over its sockets: it could not limit the connections of one
address, or the time that a client takes to send a request head. sqlr and jsonr moved to Rust for
the same reasons, so the owner knows that stack.

The console is different. It is a web app with a router, forms and charts, which runs in the browser
of the owner. A UI toolkit makes it shorter and easier to change. See `console-web-app.md`.

## Decision

**The server, its threads and the client commands are Rust. The binary uses a short list of crates:
`tokio` for the sockets and the timers, `rustls`, `tokio-rustls` and `ring` for TLS, the HMAC and
the SHA-256, `ureq` for the HTTP calls of the client, `flate2` for gzip, and `libc` for the free
disk space, the user id and the network interfaces. Only the page of the console uses imp.**

- The HTTP server is a module of the repo on `tokio`. It reads each request head and body itself, so
  it can enforce a deadline and a size at each step, see `connection-limits-and-deadlines.md`.
- JSON, the argument parser, the URL parser, the tables, the tar format, the logger and the test
  helpers are small modules in the repo. Each one has tests.
- The storage, the queries and the write-ahead log run on their own OS threads. The HTTP threads
  never write the column files.
- The page of the console is an imp project in `console/`. `imp build` makes static files with no
  runtime dependency, and a build script of the crate puts `console/dist` into the binary.
- The page needs a few modules that the CLI has in Rust: the token, the SHA-256, the query parser,
  the merge of the answers and the UTC days. They are JavaScript in `console/src/shared/`. A shared
  fixture, `console/test/merge-cases.json`, makes both sides give the same numbers.
- The code has no comments. Names carry the intent, and the docs and the ADRs carry the reasons.
- `xtask/` is the dev tool, and it is not part of the binary. It uses the crates of the server, and
  `pulldown-cmark` without its default features. The site task needs a CommonMark parser for the
  pages of `docs/`, and a correct parser is large. See `static-site-with-docs.md`.
- `cargo verify` runs `cargo fmt --check`, `cargo clippy -D warnings` and the tests, then
  `imp fmt --check`, `imp lint` and `imp test --unit` in `console/`.

## Consequences

- The public endpoint and the storage have a small supply chain: the crates above and their own
  dependencies, pinned in `Cargo.lock`.
- The binary is static on Linux (musl) and has no runtime. It needs no JIT, so the service can deny
  memory that is both writable and executable.
- The binary carries the built page. The build needs the `imp` binary to build the page.
- The repo owns a few helpers that a library would give. Each one is small and tested.
- The parser and the merge of a query exist twice, in Rust for the CLI and in JavaScript for the
  page. The shared fixture and the tests of both sides keep them equal.
- Paths use `/` only. The server supports Linux and macOS, not Windows.
