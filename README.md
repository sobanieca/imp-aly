# imp-aly

A small analytics server for [imp](https://github.com/sobanieca/imp-ui) apps. Run it on your own
VPS. It takes the records of `imp/analytics`, checks each one against the app map of your app,
stores them on the local disk in plain text column files, and answers queries.

- One binary. No database, no runtime, no dependency.
- A synced write-ahead log before each answer, and a crash-safe column store behind it.
- Records checked against `app-map.txt`, strict field rules, and a rate limit per address.
- Retention by free disk space: the oldest days lose their records first and keep their daily
  summaries, so the history is as long as the disk allows.
- Compressed backups of the daily summaries, which the server can restore and query.
- A private query API with one-time tokens, so the key never goes over the network.

imp-aly is not released yet. Until version `1.0.0`, any part of it can change.

## Install and start

```sh
curl -fsSL https://sobanieca.github.io/imp-aly/install.sh | bash
sudo imp-aly server --port 2980
imp-aly app add myapp https://myapp.example/app-map.txt
```

Then send the records from your app:

```js
import { batch, onAnalytics } from 'imp/analytics'

onAnalytics(
  batch((records) =>
    navigator.sendBeacon('https://analytics.myapp.example/collect/myapp', JSON.stringify(records))
  ),
)
```

And read the numbers:

```sh
imp-aly query '{"app": "myapp", "groupBy": ["page", "type"], "measures": ["records", "visits"]}'
```

The docs are in [`docs/`](docs/). Read the [Introduction](docs/introduction.md) for the key words,
then [Getting started](docs/getting-started.md).

## Work on imp-aly

You need [Deno](https://deno.com/) 2.

| Task                | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `deno task start`   | runs the server from source in the foreground on ports 2980 and 2981 |
| `deno task test`    | runs the tests                                                       |
| `deno task check`   | runs `deno fmt`, `deno lint`, then the tests                         |
| `deno task compile` | builds the binary `./imp-aly`                                        |

The decisions behind the design are in [`adr/`](adr/).
