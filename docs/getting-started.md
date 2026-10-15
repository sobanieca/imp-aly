# imp-aly - Getting started

imp-aly is a small server that stores the analytics records of imp apps. You run it on your own VPS.
It accepts the records that the `imp/analytics` sink of your app sends, checks each record against
the build file of your app, and stores the records on the local disk. You read the numbers back with
queries.

For the key words and an overview of how the server works, read the [Introduction](introduction.md).

The server is one file. It needs no database, no runtime and no other service.

## Install

Run this command on the VPS:

```sh
curl -fsSL https://sobanieca.github.io/imp-aly/install.sh | bash
```

The script supports Linux and macOS, on x64 and arm64. It installs `imp-aly` to `/usr/local/bin`,
for all users. If you can't write to that folder, the script stops with an error: run it with
`sudo bash` instead of `bash`. To install to a custom location, set `INSTALL_DIR` to a folder on your
`PATH`, such as `curl -fsSL https://sobanieca.github.io/imp-aly/install.sh | INSTALL_DIR=~/.local/bin bash`.
Run the same command again to update.

## Start the server

```sh
sudo imp-aly server --port 2980
```

As root on Linux with systemd, this command installs the systemd service `imp-aly`, starts it,
prints the address and the key, and exits. The service starts again after a reboot. Run the same
command again at any time to see the address and the key. When you change an option, the command
updates the service and restarts it.

The service does not run as root. The command creates the system user `imp-aly`, which can write
only the data folder `/var/lib/imp-aly`. The key file stays with root, and systemd gives the service
a copy of it at each start. Install the binary in `/usr/local/bin`, as the install script does. The
service cannot run a binary in `/root` or `/home`.

```
imp-aly 0.1.0 - systemd service "imp-aly" installed and started

  Address:   http://203.0.113.10:2980
  Collect:   http://203.0.113.10:2980/collect/<app>
  Admin:     http://203.0.113.10:2981  (the app, query, backup and status commands)
  Key:       kD3xW9q1mZ8pR4tY7uH2cV6bN0aS5fGj
  Key file:  /root/.secret/imp-aly-key
  Data:      /var/lib/imp-aly
```

Without root, or without systemd, the server runs in the foreground, with the data folder
`~/.imp-aly`. `--foreground` forces this. `Ctrl+C` stops it. `sudo imp-aly server --uninstall`
removes the service. The data folder, the key file and the user `imp-aly` stay.

The service updates itself once a day to a compatible release that is more than 7 days old. See
[Updates](update.md).

**Keep the key secret.** The key gives access to the queries and to the app registry. The `Collect`
endpoint is public and needs no key.

## The two ports

The server listens on two ports:

| Port   | Option         | Endpoints                                           | Who calls it                 |
| ------ | -------------- | --------------------------------------------------- | ---------------------------- |
| `2980` | `--port`       | `/collect/<app>`                                    | the browsers of your users   |
| `2981` | `--admin-port` | `/apps`, `/query`, `/status`, `/backup`, `/restore` | the client commands, and you |

Each port answers only its own endpoints. Open the public port to the internet. Open the admin port
only to the machines that run the client commands, for example with the firewall of the VPS:

```sh
sudo ufw allow 2980/tcp
sudo ufw allow from 198.51.100.7 to any port 2981 proto tcp
```

When you call the commands only on the VPS, give `--admin-bind 127.0.0.1`. Then the admin port is
not on the network. From another machine, use an SSH tunnel: `ssh -L 2981:127.0.0.1:2981 <vps>`.

## Serve HTTPS

A page on HTTPS cannot send records to a server on plain HTTP. Use one of these two ways:

- Put the server behind a proxy that ends TLS, such as Caddy or nginx. Send the public host to the
  public port. Start the server with `--ip-header x-forwarded-for`, so that the rate limit sees the
  address of each visitor and not the address of the proxy. When the proxy runs on another machine,
  also give `--trusted-proxy <proxy address>`. See [Collecting records](collect.md#behind-a-proxy).
  To call the admin port over HTTPS, give it its own host in the proxy, and limit that host to your
  addresses. The console on a phone calls this host too.
- Give the server a certificate: `--tls-cert fullchain.pem --tls-key privkey.pem`. Both ports then
  serve HTTPS.

The server checks the certificate files once an hour. When a file changes, for example after a
renewal by certbot, the server in the foreground opens new listeners with the new certificate, and
then closes the old ones. The port answers all the time, and running requests finish. When the new
certificate does not work, the server keeps the old one and logs an error. The service restarts
completely, because systemd gives it a copy of the files at each start. Requests that arrive during
the restart fail, and a sink loses some records.

## Register an app

The server accepts records only for an app that you register. Give the app a name and the file of
its build. `imp build` writes `app-analytics.json` at the root of the build output, with the route
patterns, the zone names and the outcome names of the app. Give the URL of the folder where the
build is served:

```sh
imp-aly app add myapp https://myapp.example/
```

The server reads the file at once and again every 10 minutes. You can also upload the file of the
build folder, for example from your deploy pipeline:

```sh
imp-aly app add myapp dist
```

See [Apps](apps.md) for segments and for the other app commands.

## Send records from your app

Register the imp-aly sink of imp in the entry module of your app. It is in `imp/analytics/aly`:

```js
import { flag, mount } from 'imp'
import { onAnalytics } from 'imp/analytics'
import { alySink } from 'imp/analytics/aly'
import { app } from './app.js'

if (flag('ANALYTICS')) {
  onAnalytics(alySink({ app: 'myapp', servers: ['https://analytics.myapp.example'] }))
}

mount('#app', app())
```

The sink sends the records in batches to `https://analytics.myapp.example/collect/myapp`. It sends
the first record of a visit at once, and the next records every 5 seconds or 20 records. It also
sends a batch when the page hides. When the server rejects records, the sink logs a warning in the
browser console. The
[Analytics](https://github.com/sobanieca/imp-ui/blob/main/docs/analytics.md#imp-aly) page of imp
gives all the options.

The server accepts the records exactly as imp makes them. It drops a record whose `page`, zone or
outcome name is not in the build file.

## Read the numbers

Run a query on the VPS:

```sh
imp-aly query '{"app": "myapp", "groupBy": ["page", "type"], "measures": ["records", "visits"]}'
```

```
page            type   records   visits
/invoices/:id   seen     12400     6100
/invoices       page      9800     8400
/invoices/:id   used      8100     4900
...
```

See [Queries](query.md) for the query fields and for the queries of the imp report.

## Use the commands from another machine

The commands `app`, `query` and `status` call the admin port of the server. On the VPS they need no
option. On another machine, save the server once with the URL of its admin port and its key file.
Then the commands call it:

```sh
imp-aly add myvps http://203.0.113.10:2981 -a ~/.secret/imp-aly-key
imp-aly query '{"app": "myapp"}'
```

You can save many servers. `-s <name>` selects one of them. See [CLI](cli.md#saved-servers).

The key never goes over the network. Each call sends a token that the key signs, and the server
accepts each token once. See [Security](security.md).

## See the numbers in the console

Open `https://sobanieca.github.io/imp-aly/console/` on your phone or your computer, and install it
from the menu of the browser. Or run `imp-aly console` and open `http://localhost:8010`. In
**Servers**, add the URL of the admin port and the key. The installed console needs HTTPS on the
admin port, see [Serve HTTPS](#serve-https).

The console shows the visits of your apps, and the pages, zones, outcomes and errors of each app, in
charts. It also has pages for the apps and the servers. Make backups with `imp-aly backup`, see
[Backup](backup.md). See [Console](console.md).

## Next

- [Collecting records](collect.md) - the public endpoint, the checks and the rate limit
- [Apps](apps.md) - the registry, the build file and the segments
- [Queries](query.md) - the query API
- [Storage](storage.md) - how the server stores the records and removes old ones
- [Backup](backup.md) - save the daily, week or month summaries, restore them, and keep them safe
- [Console](console.md) - the web app with charts of your apps, and pages for apps and servers
- [Security](security.md) - the key, the tokens and the limits
- [Updates](update.md) - the daily update, and how to control it
- [CLI](cli.md) - every command and option
