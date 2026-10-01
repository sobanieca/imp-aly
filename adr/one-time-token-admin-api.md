# The private API takes one-time tokens signed with a key

## Context

The queries and the app registry must be private. The owner calls them from the VPS and from a
laptop, often over plain HTTP during setup. A static bearer key sent with each call can be captured.
tunnelr already solves this with a key that never travels.

## Decision

**The private endpoints accept `Authorization: Bearer <token>`, where the token is
`<ms>.<nonce>.<hmac>` signed with the key of the server. Each token is valid once, for 60 seconds.**

- The key is 32 random letters and digits, made on first start and saved with mode `600` to
  `~/.secret/imp-analytics-server-key`. `-a` takes a key or a key file.
- The server compares the signature in constant time, rejects a time more than 60 seconds away from
  its clock, and keeps each used nonce until the token cannot be valid again.
- The CLI makes a new token for each call. `imp-analytics-server token` prints one for other tools.
- The token is not accepted in the URL, so it does not end up in an access log.

## Consequences

- A captured token is useless after its one use.
- The clocks of the client and the server must agree to within 60 seconds.
- The answers of the API are not encrypted on plain HTTP. The docs tell the owner to use HTTPS for
  remote use.
