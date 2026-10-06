# The private API takes one-time tokens signed with a key

## Context

The queries and the app registry must be private. The owner calls them from the VPS and from a
laptop, often over plain HTTP during setup. A static bearer key sent with each call can be captured.
tunnelr already solves this with a key that never travels.

## Decision

**The private endpoints accept `Authorization: Bearer <token>`, where the token is
`<ms>.<nonce>.<body-sha256>.<hmac>` signed with the key of the server. The signature covers the
request: the method, the path with its query string, and the hash of the body. Each token is valid
once, for 60 seconds.**

- The private endpoints are on their own port, see `separate-admin-port.md`.
- The key is 32 random letters and digits, made on first start and saved with mode `600` to
  `~/.secret/imp-aly-key`. `-a` takes a key or a key file. `imp-aly key rotate` changes it while the
  server runs, see `key-rotation.md`.
- The signed text is the time, the nonce, the method in capitals, the path with its query string,
  and the hex SHA-256 of the body, joined with line breaks. The client and the server normalize the
  path in the same way, with `new URL`. A proxy that removes a path prefix keeps the signature
  valid, because the client signs the path of the endpoint without the prefix of the server URL.
- The server checks the signature from the headers, before it reads the body. So a request without a
  valid token cannot upload anything. After the read, the server compares the hash of the body with
  the signed hash and answers `401` when they differ. An endpoint without a body requires the hash
  of an empty body.
- A restore upload can be 4 GiB, so both sides hash it as a stream. `crypto.subtle.digest` takes
  only a whole buffer, so `src/sha256.js` is a small streaming SHA-256.
- The server compares the signature in constant time, rejects a time more than 60 seconds away from
  its clock, and keeps each used nonce until the token cannot be valid again.
- The CLI makes a new token for each call. `imp-aly token <method> <path> [<body file>]` prints one
  for other tools.
- The token is not accepted in the URL, so it does not end up in an access log.
- The admin port answers CORS for every origin: `access-control-allow-origin: *`, and a preflight
  that allows `GET`, `POST`, `PUT`, `DELETE` and the headers `authorization` and `content-type`. The
  API uses no cookie and trusts no address, so a page without the key gets only `401`. This lets the
  console page call the servers from the browser, see `console-web-app.md`.

## Consequences

- A captured token is useless after its one use, and it never works for another request, not even
  before its use.
- The clocks of the client and the server must agree to within 60 seconds.
- A tool that calls the API must send the body exactly as it signed it.
- The answers of the API are not encrypted on plain HTTP. The docs tell the owner to use HTTPS for
  remote use.
- Any web page can send a request to the admin port and read the `401`. It cannot make a valid token
  without the key.
