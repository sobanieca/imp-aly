# imp-aly

Website: https://sobanieca.github.io/imp-aly/

A small analytics server for [imp](https://github.com/sobanieca/imp-ui) apps. Run it on your own
VPS. It takes the records of `imp/analytics`, checks each one against the build file of your app,
stores them on the local disk in plain text column files, and answers queries.

- One binary. No database and no runtime. The server has no dependency.
- A synced write-ahead log before each answer, and a crash-safe column store behind it.
- Records checked against `app-analytics.json` from `imp build`, strict field rules, and a rate
  limit per address.
- Retention by free disk space: the oldest days lose their records first and keep their daily
  summaries, so the history is as long as the disk allows.
- Compressed backups of the daily, week or month summaries, which the server can restore and query.
- A private query API with one-time tokens, so the key never goes over the network.

imp-aly is not released yet. Until version `1.0.0`, any part of it can change.

## Install and start

```sh
curl -fsSL https://sobanieca.github.io/imp-aly/install.sh | bash
sudo imp-aly server --port 4411
imp-aly app add myapp https://myapp.example/
```

Then send the records from your app with the imp-aly sink of imp, `imp/analytics/aly`:

```js
import { onAnalytics } from 'imp/analytics'
import { alySink } from 'imp/analytics/aly'

onAnalytics(alySink({ app: 'myapp', servers: ['https://analytics.myapp.example'] }))
```

The sink sends the records in batches to `<server>/collect/<app>`. With several servers in the list,
it sends each visit to one server, and to the next server when that server fails. See
[Analytics](https://github.com/sobanieca/imp-ui/blob/main/docs/analytics.md#imp-aly) in the imp
docs.

And read the numbers:

```sh
imp-aly query '{"app": "myapp", "groupBy": ["page", "type"], "measures": ["records", "visits"]}'
```

Or open the console, a web app with charts of your apps, and pages for the apps and the servers.
Install it on your phone from https://sobanieca.github.io/imp-aly/console/, add your servers with
their keys, and choose an app. Each report asks the servers that have the app. Or serve it on your
machine:

```sh
imp-aly console
```

The docs are on the [website](https://sobanieca.github.io/imp-aly/docs/), and their sources are in
[`docs/`](docs/). Read the [Introduction](docs/introduction.md) for the key words, then
[Getting started](docs/getting-started.md).

To let an AI agent query your analytics, run `imp-aly skill --init`. Then ask the agent with
`/imp-aly`. See [CLI](docs/cli.md#ai-agents).

## Work on imp-aly

You need [Rust](https://rustup.rs/) 1.85 or newer, and [imp](https://github.com/sobanieca/imp-ui) to
build and check the page of the console. The server is Rust. The console is an imp project in
`console/`.

| Task                  | What it does                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo start`         | starts a demo: a server on ports 4411 and 4410 (admin) with 45 days of sample data in `.dev-data/` and new visits, and the console on port 4400 |
| `cargo server`        | runs the server from source in the foreground on ports 4411 and 4410                                                                            |
| `cargo console`       | builds the page of the console, and runs the console from source on port 4400                                                                   |
| `cargo console-build` | builds the page of the console into `console/dist`                                                                                              |
| `cargo test`          | runs the tests of the server                                                                                                                    |
| `cargo verify`        | runs `cargo fmt`, `cargo clippy` and the tests, then `imp fmt`, `imp lint` and `imp test --unit` in `console/`                                  |
| `cargo compile`       | builds the page of the console and the release binary `target/release/imp-aly`                                                                  |
| `cargo site`          | builds the website into `site/dist/` and serves it with [rfm](https://sobanieca.github.io/remote-file-manager/)                                 |

The decisions behind the design are in [`adr/`](adr/).
