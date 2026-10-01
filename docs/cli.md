# imp-analytics-server - CLI

```
imp-analytics-server [options]                     start the server
imp-analytics-server --uninstall                   remove the systemd service
imp-analytics-server app add <name> <map url|file> [--segments plan,role]
imp-analytics-server app ls | show <name> | refresh <name> | rm <name>
imp-analytics-server query '<json>' | query <file.json> [--json]
imp-analytics-server status
imp-analytics-server token
imp-analytics-server help | version
```

`imp-analytics-server help` prints the same reference in the terminal.

## Start the server

```sh
sudo imp-analytics-server --port 2980
```

| Option                     | Value                                            | Default                              |
| -------------------------- | ------------------------------------------------ | ------------------------------------ |
| `-p`, `--port <port>`      | the port to listen on                            | `2980`                               |
| `-d`, `--data <folder>`    | the data folder                                  | `~/.imp-analytics-server`            |
| `-a`, `--auth <key\|file>` | the key, or a file with the key                  | `~/.secret/imp-analytics-server-key` |
| `--bind <address>`         | listen on this address only                      | all addresses                        |
| `--ip-header <name>`       | read the client address from this header         | the address of the connection        |
| `--country-header <name>`  | store the country from this header               | no country                           |
| `--min-free <size>`        | the free disk space to keep, as `10%` or `5GB`   | `10%`                                |
| `--tls-cert <file>`        | serve HTTPS with this certificate, in PEM        | plain HTTP                           |
| `--tls-key <file>`         | the private key of the certificate, in PEM       |                                      |
| `--limit-5s <n>`           | records per address in 5 seconds                 | `200`                                |
| `--limit-1m <n>`           | records per address in 1 minute                  | `1500`                               |
| `--limit-1h <n>`           | records per address in 1 hour                    | `30000`                              |
| `--limit-24h <n>`          | records per address in 24 hours                  | `200000`                             |
| `--foreground`             | do not touch systemd, run in the foreground      |                                      |
| `--uninstall`              | stop and remove the systemd service              |                                      |
| `--debug`                  | log each rejected record, in the foreground only |                                      |

As root on Linux with systemd, the command writes `/etc/systemd/system/imp-analytics-server.service`
with the options that you give, starts the service, prints the address and the key, and exits. When
the unit file is already the same, the command only prints. When an option changes, the command
writes the new unit file and restarts the service. Without root, or without systemd, the server runs
in the foreground.

A size for `--min-free` is a number with `B`, `KB`, `MB`, `GB` or `TB`, in units of 1024.

Read the log of the service with `journalctl -u imp-analytics-server -f`.

### Run the service as another user

The service that the command installs runs as root. To run the server as another user, write the
unit file yourself and use `--foreground`:

```ini
[Unit]
Description=imp analytics server
After=network-online.target
Wants=network-online.target

[Service]
User=analytics
ExecStart=/usr/local/bin/imp-analytics-server --foreground --port 2980 --data /var/lib/imp-analytics --auth /var/lib/imp-analytics/key
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

The user must own the data folder and the key file. A port below 1024 needs root.

## Client commands

The commands `app`, `query`, `status` and `token` take these options:

| Option                     | Value                                                 | Default                              |
| -------------------------- | ----------------------------------------------------- | ------------------------------------ |
| `--url <url>`              | the URL of the server                                 | `http://127.0.0.1:2980`              |
| `-a`, `--auth <key\|file>` | the key, or a file with the key                       | `~/.secret/imp-analytics-server-key` |
| `--json`                   | print the JSON answer (`app ls`, `app show`, `query`) |                                      |

`token` takes only `-a`. It prints a one-time token for the API, valid for 60 seconds.

`status` prints the state of the server: the version, the start time, the data folder, the number of
apps, the number of addresses in the rate limit, and the state of the storage worker. The storage
state holds the number of log parts that wait, the number of stored records since the start, the
last error, and the free disk space.

See [Apps](apps.md) for `app`, and [Queries](query.md) for `query`.

## Exit codes

A command exits with `0` on success and with `1` on an error. It prints the error on one line.
