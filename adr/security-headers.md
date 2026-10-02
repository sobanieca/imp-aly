# Every answer carries headers that stop a browser from running it

## Context

The server answers with JSON or plain text. Some errors repeat a part of the request, such as the
name of an app. A browser that guesses the type of an answer can read such text as HTML. A page that
shows an answer in a frame can also mislead a user.

## Decision

**Every answer, on both ports, carries `x-content-type-options: nosniff` and
`content-security-policy: default-src 'none'; frame-ancestors 'none'`.**

- The server adds the headers as the last step of each request, also to `429`, `503` and error
  answers, to the preflight and to the backup stream.
- The headers do not change the CORS headers of the public endpoint. A `fetch` or `sendBeacon` from
  an imp app works as before.

## Consequences

- A browser never reads an answer as HTML, and an answer opened as a page cannot load a script or an
  image.
- Another site cannot show an answer in a frame.
