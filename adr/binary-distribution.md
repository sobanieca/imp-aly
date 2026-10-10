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
- `install.sh` detects the platform, downloads the latest asset and its checksum, and copies the
  asset to a temporary file in the install folder, by default `/usr/local/bin`. It checks the
  checksum of that file, sets its mode, and renames it to `imp-aly`. A rename in one folder is
  atomic, so a running server or a failed install never sees half a binary. GitHub Pages serves the
  script next to the landing page, `site/index.html`.
- The workflow runs the pushes to `main` one after the other, in the concurrency group `release`
  with `cancel-in-progress: false`. So two quick pushes cannot both see that the tag is missing, and
  cannot both publish the same version. A pull request runs in a group of its own.
- The Pages job runs after the release, and writes `versions.json` with each released version and
  its data format. `imp-aly update` reads it. See [automatic-updates](automatic-updates.md).
- Every release stays on GitHub Releases, so the URL of each version stays valid.

## Consequences

- A release needs only a version bump in `deno.json`.
- A push with the same version builds nothing.
- The install and the update trust GitHub Releases and HTTPS. The SHA-256 file comes from the same
  release as the binary. So it finds a damaged download, but not a changed release.
