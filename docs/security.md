# imp-analytics-server - Security

The server has a public part and a private part.

| Part    | Endpoints                      | Protection                         |
| ------- | ------------------------------ | ---------------------------------- |
| public  | `POST /collect/<app>`, `GET /` | app map, record checks, rate limit |
| private | `/apps`, `/query`, `/status`   | a one-time token signed with a key |

## The key

The server creates a random key of 32 letters and digits when it starts for the first time. It saves
the key to `~/.secret/imp-analytics-server-key`, with access for the owner only, and prints it.
`-a <key or file>` gives another key or another key file.

The commands `app`, `query`, `status` and `token` read the same file by default. On another machine,
save the key in that file, or pass `-a <file>`.

**The key never goes over the network.** For each call, the command makes a token of three parts:
the time, a random value and an HMAC-SHA256 signature of the two with the key. The server checks the
signature, accepts a token that is at most 60 seconds old, and accepts each token once. A token that
somebody captures is of no use to them.

The clocks of both machines must agree to within 60 seconds.

To call the API with another tool, get a token from the command:

```sh
curl -H "Authorization: Bearer $(imp-analytics-server token)" http://127.0.0.1:2980/status
```

To change the key, delete the key file and start the server again. With the systemd service, run
`sudo imp-analytics-server --port 2980` again, then `sudo systemctl restart imp-analytics-server`.

## Use HTTPS

The tokens cannot be reused, but a query answer travels in clear text over plain HTTP. Serve the
server through HTTPS when you call the API from another machine. See
[Getting started](getting-started.md).

## The public endpoint

Anybody can send records to `/collect/<app>`. The server limits what a sender can do:

- **The app map.** The server stores a record only when its `page` is a route pattern of the app. A
  sender cannot fill the data with invented paths.
- **The record checks.** Each field has a type, a size and a set of allowed characters. A record
  with an unknown field fails. See [Collecting records](collect.md).
- **The size limits.** A request has at most 64 KiB and 100 records. The server reads a body for at
  most 10 seconds.
- **The rate limit.** Each address can send a limited number of records in 5 seconds, 1 minute, 1
  hour and 24 hours. Over a limit, the server answers `429` without reading the body.
- **The disk.** Retention keeps a minimum of free space. See [Storage](storage.md).

A sender can still send valid records with invented counts, up to the rate limit. No public endpoint
can prevent that. Read the numbers as estimates, and watch for a sudden rise from one address or one
country.

## What the server stores

The server stores the fields of each record, the UTC day, and the country when you set
`--country-header`. It does not store the address of a client, a user agent or a cookie. The rate
limit keeps the recent addresses in memory only.

imp sends no personal data in a record. Keep it that way in your sink, and do not add a user id or
an organization id as a segment.

## Run as root

The systemd service runs as root, like the command that installs it. To run the server as another
user, install the service yourself with `--foreground` and a `User=` line. See [CLI](cli.md).
