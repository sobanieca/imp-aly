# Binaries on GitHub Releases, with a checksum

## Context

The owner installs the server with one command on a VPS. The release must give a binary per platform
at a fixed URL, and the install must check that the download is intact.

## Decision

**CI builds the binary per platform on a push to `main` when the version in `deno.json` has no tag,
and publishes it with a SHA-256 file to a GitHub Release.**

- The version in `deno.json` is the source of truth. `--version` imports it.
- The targets are Linux and macOS on x64 and arm64. Each one builds on a runner of its own platform
  and runs a smoke test: start, register an app, send a record, query it.
- The assets are `imp-aly-{linux|macos}-{x64|arm64}` and a `.sha256` file for each.
- `install.sh` detects the platform, downloads the latest asset and its checksum, checks it, and
  installs to `/usr/local/bin`. GitHub Pages serves the script next to the landing page,
  `site/index.html`.

## Consequences

- A release needs only a version bump in `deno.json`.
- A push with the same version builds nothing.
