# imp-analytics-server - Getting started

imp-analytics-server is a small server that stores the analytics records of imp apps. You run it on
your own VPS. It accepts the records that the `imp/analytics` sink of your app sends, checks each
record against the app map of your app, and stores the records on the local disk. You read the
numbers back with queries.

The server is one file. It needs no database, no runtime and no other service.

## Install

Run this command on the VPS:

```sh
curl -fsSL https://sobanieca.github.io/imp-analytics-server/install.sh | bash
```

The script supports Linux and macOS, on x64 and arm64. It installs `imp-analytics-server` to
`/usr/local/bin`. Run the same command again to update.

## Start the server

```sh
sudo imp-analytics-server --port 2980
```

As root on Linux with systemd, this command installs the systemd service `imp-analytics-server`,
starts it, prints the address and the key, and exits. The service starts again after a reboot. Run
the same command again at any time to see the address and the key. When you change an option, the
command updates the service and restarts it.

```
imp-analytics-server 0.1.0 - systemd service "imp-analytics-server" installed and started

  Address:   http://203.0.113.10:2980
  Collect:   http://203.0.113.10:2980/collect/<app>
  Key:       kD3xW9q1mZ8pR4tY7uH2cV6bN0aS5fGj
  Key file:  /root/.secret/imp-analytics-server-key
  Data:      /root/.imp-analytics-server
```

Without root, or without systemd, the server runs in the foreground. `--foreground` forces this.
`Ctrl+C` stops it. `sudo imp-analytics-server --uninstall` removes the service. The data folder and
the key file stay.

**Keep the key secret.** The key gives access to the queries and to the app registry. The `Collect`
endpoint is public and needs no key.

## Serve HTTPS

A page on HTTPS cannot send records to a server on plain HTTP. Use one of these two ways:

- Put the server behind a proxy that ends TLS, such as Caddy or nginx. Start the server with
  `--ip-header x-forwarded-for`, so that the rate limit sees the address of each visitor and not the
  address of the proxy. See [Collecting records](collect.md).
- Give the server a certificate: `--tls-cert fullchain.pem --tls-key privkey.pem`.

## Register an app

The server accepts records only for an app that you register. Give the app a name and its app map.
`imp build` writes the app map to `app-map.txt` at the root of the build output:

```sh
imp-analytics-server app add myapp https://myapp.example/app-map.txt
```

The server reads the map at once and again every 10 minutes. You can also upload the file, for
example from your deploy pipeline:

```sh
imp-analytics-server app add myapp dist/app-map.txt
```

See [Apps](apps.md) for segments and for the other app commands.

## Send records from your app

Register a sink in the entry module of your app. Send the records with `batch` and `sendBeacon`:

```js
import { flag, mount } from 'imp'
import { batch, onAnalytics } from 'imp/analytics'
import { app } from './app.js'

if (flag('ANALYTICS')) {
  onAnalytics(batch((records) =>
    navigator.sendBeacon(
      'https://analytics.myapp.example/collect/myapp',
      JSON.stringify(records),
    )
  ))
}

mount('#app', app())
```

The server accepts the records exactly as imp makes them. It drops a record whose `page` is not a
line of the app map.

## Read the numbers

Run a query on the VPS:

```sh
imp-analytics-server query '{"app": "myapp", "groupBy": ["page", "type"], "measures": ["records", "visits"]}'
```

```
page            type          records   visits
/invoices       interaction     31000     8100
/invoices/:id   interaction     52000     6000
/invoices       page             9800     8400
...
```

See [Queries](query.md) for the query fields and for the queries of the imp report.

## Use the commands from another machine

The commands `app`, `query` and `status` call the API of the server. On the VPS they need no option.
From another machine, give the URL of the server and the key:

```sh
imp-analytics-server query '{"app": "myapp"}' --url https://analytics.myapp.example -a ~/.secret/imp-analytics-server-key
```

The key never goes over the network. Each call sends a token that the key signs, and the server
accepts each token once. See [Security](security.md).

## Next

- [Collecting records](collect.md) - the public endpoint, the checks and the rate limit
- [Apps](apps.md) - the registry, the app map and the segments
- [Queries](query.md) - the query API
- [Storage](storage.md) - how the server stores the records and removes old ones
- [Security](security.md) - the key, the tokens and the limits
- [CLI](cli.md) - every command and option
