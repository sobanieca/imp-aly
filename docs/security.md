# imp-aly - Security

The server has a public part and a private part. Each part has its own port.

| Part    | Port   | Endpoints                                           | Protection                             |
| ------- | ------ | --------------------------------------------------- | -------------------------------------- |
| public  | `2980` | `POST /collect/<app>`, `GET /`                      | build files, record checks, rate limit |
| private | `2981` | `/apps`, `/query`, `/status`, `/backup`, `/restore` | a one-time token signed with a key     |

`--port` and `--admin-port` change the ports. A port answers `404` to the endpoints of the other
part.

## Close the admin port

**An open admin port lets anybody on the internet try tokens against the server.** The tokens are
strong, and the rate limit counts each try. But it is safer when a stranger cannot reach the port:

- Let the firewall accept the admin port only from your machines.
- Or give `--admin-bind 127.0.0.1`, and call the commands on the VPS or through an SSH tunnel.

The console calls the admin port from your phone or your computer. So the device must reach the
port. A VPN gives a phone a fixed address that the firewall can accept.

A flood on the public port does not block the admin port. Each port has its own limit of requests in
progress.

## The key

The server creates a random key of 32 letters and digits when it starts for the first time. It saves
the key to `~/.secret/imp-aly-key`, with access for the owner only, and prints it.
`-a <key or file>` gives another key or another key file. A key as text goes into the key file when
the file is empty. When the file holds a different key, the server does not start, and the file does
not change. When the key file cannot be read or written, the command stops and shows the reason.

The commands `app`, `query`, `status` and `token` read the same file by default. On another machine,
save the key in that file, pass `-a <file>`, or save the server with its key file:
`imp-aly add <name> <url> -a <file>`. The list of saved servers holds the path of the key file. It
holds the key only when you give the key as text. The list has access for the owner only.

**The key never goes over the network.** For each call, the command makes a token of four parts: the
time, a random value, the SHA-256 hash of the body, and an HMAC-SHA256 signature. The signature
covers the time, the random value, the method, the path with its query string, and the hash of the
body. The server checks the signature before it reads the body. It then checks that the body has the
signed hash. It accepts a token that is at most 60 seconds old, and accepts each token once.

So a token works for one request only. Somebody who captures a token cannot use it for another
endpoint, another method, another query string or another body. A request without a body signs the
hash of an empty body.

The clocks of both machines must agree to within 60 seconds.

To call the API with another tool, get a token for the method and the path. For a request with a
body, give the file of the body too, and send the file exactly as it is:

```sh
curl -H "Authorization: Bearer $(imp-aly token GET /status)" http://127.0.0.1:2981/status
curl -H "Authorization: Bearer $(imp-aly token POST /query query.json)" \
  --data-binary @query.json http://127.0.0.1:2981/query
```

Use `--data-binary`. `curl -d` removes the line breaks, so the body no longer has the signed hash.

### Change the key

When the key leaks, change it on the VPS:

```sh
sudo imp-aly key rotate
```

The command makes a new key, writes it to the key file of the service and prints it. The service
loads the new key and does not stop. The command gives the key to the service in `/run/imp-aly`, a
folder that only root can write. The service can read the key there, but cannot change a file of
root. From then on, it refuses each token that the old key signed. `/collect` does not stop, so no
record is lost. When the service does not load the new key within 5 seconds, the command shows an
error. Then restart the service: `sudo systemctl restart imp-aly`.

The command runs only as root on the VPS. The API has no endpoint that changes the key. So somebody
who has the old key cannot change the key and lock you out.

For a server in the foreground, run `imp-aly key rotate`, or `imp-aly key rotate -a <file>` when the
server uses another key file. Then send `SIGHUP` to the server (`kill -HUP <pid>`), or start it
again. Until then, the server uses the old key.

After the change, give the new key to each machine that calls the server. Write it to the key file
of that machine, or save the server again: `imp-aly add <name> <url> -a <file>`. In the console, use
"Change the URL or the key" on the server.

## Use HTTPS

The tokens cannot be reused, but a query answer travels in clear text over plain HTTP. Serve the
server through HTTPS when you call the API from another machine. See
[Getting started](getting-started.md). The installed console on `https` calls only servers on HTTPS.

## The console

The admin port answers a browser page from every web address, with `access-control-allow-origin: *`.
So the console can call the server from any address where it is installed. This gives a page no
access without the key. The admin port uses no cookie and trusts no address. A page without the key
gets `401`.

The console keeps the key in the browser in a form that no script can read back. It signs a token
for each call, like the CLI. Anybody who can open the console on your device can use the servers.
See [Console](console.md#how-the-console-keeps-your-keys).

## The public endpoint

Anybody can send records to `/collect/<app>`. The server limits what a sender can do:

- **The build file.** The server stores a record only when its `page`, its zone and its outcome name
  are in the `pages`, `zones` and `outcomes` lists of `app-analytics.json`. A sender cannot fill the
  data with invented pages, zones or outcomes.
- **The record checks.** Each field has a type, a size and a set of allowed characters. A record
  with an unknown field fails. See [Collecting records](collect.md).
- **Plain characters only.** A zone, an outcome name and a segment value hold only ASCII letters,
  digits and a few signs. HTML, a script, a shell command or a Unicode trick fails the checks.
- **The size limits.** A request has at most 64 KiB. The server reads a body for at most 5 seconds.
- **The rate limit.** Each address can send a limited number of records in 5 seconds, 1 minute, 1
  hour and 24 hours. Over a limit, the server answers `429` without reading the body. An IPv6 `/48`
  network has a limit too.
- **The requests in progress.** The server works on at most 1,024 requests at one time on each port.
  Above this number, it answers `503` at once. One address can have at most 32 of them, then the
  server answers `429`.
- **The allowed origins.** With `--allow-origin`, the server refuses records from a browser page of
  another site. So a script on another site cannot use the browsers of its visitors to send records.
  See [Collecting records](collect.md#cors-and-allowed-origins).
- **The proxy header.** With `--ip-header`, the server reads the header only from a trusted proxy. A
  client that connects directly cannot give a false address.
- **The disk.** Retention keeps a minimum of free space. See [Storage](storage.md).

The server never runs or reads a stored value as code. It has no shell step, no SQL and no HTML
page. The checks also protect the tools that you use to read the data.

Each answer, on both ports, has these headers:

- `x-content-type-options: nosniff`. A browser does not read a JSON answer as HTML or a script.
- `content-security-policy: default-src 'none'; frame-ancestors 'none'`. When a browser opens an
  answer as a page, the page cannot load anything, and another site cannot show it in a frame.

A sender can still send valid records with invented counts, up to the rate limit. No public endpoint
can prevent that. Read the numbers as estimates, and watch for a sudden rise from one address or one
country.

## Large attacks

The limits stop one sender, or a small group of senders. They do not stop a large distributed attack
(DDoS). The memory of the limits stays the same in an attack. But:

- A sender with more than 400,000 addresses gets past the rate limit, because the server forgets the
  oldest addresses.
- The server must accept each connection and read each request before it can refuse it. A flood of
  connections or of bytes can use all the network or processor of the VPS.
- Valid records from many addresses fill the disk. Retention then removes the oldest days to keep
  the free space.

**A large attack can stop the server or remove old data.** For a public site, put a service that
filters attacks in front of the server. Use the DDoS protection of your provider, or a CDN such as
Cloudflare. Then set `--ip-header` and `--trusted-proxy` for that service, and let the firewall
accept connections from that service only. Make backups. See [Backup](backup.md).

## What the server stores

The server stores the fields of each record, the UTC day, and the country when you set
`--country-header`. It does not store the address of a client, a user agent or a cookie. The rate
limit keeps the recent addresses in memory only.

imp sends no personal data in a record. Keep it that way in your sink, and do not add a user id or
an organization id as a segment.

## The service user

The systemd service runs as the system user `imp-aly`, not as root. It can write only its data
folder, it cannot read `/home` or `/root`, and it has no capabilities. systemd gives it a copy of
the key and of the TLS files at each start. So a fault in the server cannot change the system or
read the key file of root. See [CLI](cli.md#the-service-user).
