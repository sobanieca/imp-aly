# imp-aly - CLI

```
imp-aly server [options]              start the server
imp-aly server --uninstall            remove the systemd service
imp-aly update [--check] [--auto]     install a newer version
imp-aly key rotate [-a <file>]        change the key, and the server does not stop
imp-aly app add <name> <app url> [--segments plan,role] [--origins <list>]
imp-aly app ls | show <name> | refresh <name> | rm <name>
imp-aly query '<json>' | query <file.json> [--json]
imp-aly backup [<file>] [--last <period>] [--by <granularity>] [-s <name>]
imp-aly restore <file>
imp-aly status
imp-aly console [--port <port>]
imp-aly token <method> <path> [<body file>]
imp-aly add <name> <url> [-a <key|file>]
imp-aly group <name> <a,b,c>
imp-aly ls | use <name> | rm <name>
imp-aly skill [--init]
imp-aly help | version
```

`imp-aly help` prints the same reference in the terminal. `imp-aly` without a command prints it too.

## Start the server

```sh
sudo imp-aly server --port 4411
```

| Option                     | Value                                                                                        | Default                       |
| -------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------- |
| `-p`, `--port <port>`      | the public port, for `/collect/<app>`                                                        | `4411`                        |
| `--admin-port <port>`      | the port of the private API                                                                  | `4410`                        |
| `-d`, `--data <folder>`    | the data folder                                                                              | see below                     |
| `-a`, `--auth <key\|file>` | the key, or a file with the key                                                              | `~/.secret/imp-aly-key`       |
| `--bind <address>`         | listen on this address only                                                                  | all addresses                 |
| `--admin-bind <address>`   | listen on this address only, on the admin port                                               | the `--bind` address          |
| `--ip-header <name>`       | read the client address from this header                                                     | the address of the connection |
| `--trusted-proxy <list>`   | read the header only from these addresses                                                    | `127.0.0.0/8,::1`             |
| `--max-requests <n>`       | requests in progress on each port, then `503`; one address can have 1/32 of them, then `429` | `1024`                        |
| `--max-connections <n>`    | open connections on each port; one address can hold 1/32 of them                             | `4096`                        |
| `--country-header <name>`  | store the country from this header                                                           | no country                    |
| `--min-free <size>`        | the free disk space to keep, as `10%` or `5GB`                                               | `10%`                         |
| `--tls-cert <file>`        | serve HTTPS with this certificate, in PEM                                                    | plain HTTP                    |
| `--tls-key <file>`         | the private key of the certificate, in PEM                                                   |                               |
| `--limit-5s <n>`           | records per address in 5 seconds                                                             | `200`                         |
| `--limit-1m <n>`           | records per address in 1 minute                                                              | `1500`                        |
| `--limit-1h <n>`           | records per address in 1 hour                                                                | `30000`                       |
| `--limit-24h <n>`          | records per address in 24 hours                                                              | `200000`                      |
| `--foreground`             | do not touch systemd, run in the foreground                                                  |                               |
| `--no-auto-update`         | do not install the update timer                                                              | the timer updates daily       |
| `--uninstall`              | stop and remove the service and the update timer                                             |                               |
| `--debug`                  | log each rejected record, in the foreground only                                             |                               |

As root on Linux with systemd, the command writes `/etc/systemd/system/imp-aly.service` with the
options that you give, starts the service, prints the address and the key, and exits. When the unit
file is already the same, the command only prints. When an option changes, the command writes the
new unit file and restarts the service. Without root, or without systemd, the server runs in the
foreground.

The default data folder of the service is `/var/lib/imp-aly`. In the foreground, it is `~/.imp-aly`.

The server checks the files of `--tls-cert` and `--tls-key` once an hour. When they change, the
server loads the new certificate. See [Getting started](getting-started.md#serve-https).

A size for `--min-free` is a number with `B`, `KB`, `MB`, `GB` or `TB`, in units of 1024.

Read the log of the service with `journalctl -u imp-aly -f`.

The command also installs the systemd timer `imp-aly-update`, which runs `imp-aly update --auto`
once a day. `--no-auto-update` removes it. See [Updates](update.md).

## Update

```sh
imp-aly update --check       # show the installed version, the update and the choice of the timer
sudo imp-aly update          # install the newest version and restart the service
sudo imp-aly update --auto   # install what the timer installs
```

The update installs only a newer version that reads the same data folder. With `--auto`, it also
stays in the major version (before `1.0.0`: the minor version), and waits 7 days after the release.
When the service does not stay running, it puts the old binary back. See [Updates](update.md).

### The service user

The service runs as the system user `imp-aly`, not as root. The command creates the user when it is
missing, and makes it the owner of the data folder. The unit file limits the service:

- It can write only the data folder. The rest of the file system is read-only, and `/home` and
  `/root` are hidden. A data folder in `/home` stays visible and writable.
- systemd reads the key file and the TLS files as root, and gives the service a copy in a private
  folder. So the files can stay readable by root only, such as the private key of certbot.
- The service has no capabilities, except `CAP_NET_BIND_SERVICE` for a port below 1024. It cannot
  get more privileges.
- New files are readable by the service user only.

The command refuses a data folder in `/root`, a binary in `/root` or `/home`, and a key or TLS path
with spaces or special signs. The service user must be able to reach the data folder. When it
cannot, the command stops and removes the folders that it created.

## Change the key

```sh
sudo imp-aly key rotate    # the service: a new key, loaded without a stop
imp-aly key rotate         # the key file of a server in the foreground
```

The command makes a new key, writes it to the key file and prints it. The service loads it at once,
and refuses the old key from then on. A server in the foreground loads it on `SIGHUP` or when it
starts again. `-a <file>` names another key file for a server in the foreground. See
[Security](security.md#change-the-key).

## Client commands

The commands `app`, `query`, `backup`, `restore` and `status` take these options:

| Option                     | Value                                                              | Default                                       |
| -------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `-s`, `--server <name>`    | a saved server, or a list `a,b,c` or a group for `app` and `query` | the default saved server                      |
| `--url <url>`              | the URL of the admin port of the server                            | the default saved server, or the local server |
| `-a`, `--auth <key\|file>` | the key, or a file with the key                                    | the key of the server, or the key file        |
| `--timeout <seconds>`      | the time to wait for each server (`app`, `query`, `status`)        | `130` for `query`, `30` for the others        |
| `--json`                   | print the JSON answer (`app ls`, `app show`, `query`, `restore`)   |                                               |

The command finds the server in this order:

1. `--server <name>`: the saved server or the group with this name, with the saved keys.
2. `--url <url>`: this URL. Do not give `--server` and `--url` together.
3. The default saved server or group, with the saved keys.
4. The local service, when this machine runs the systemd service of imp-aly. The command reads the
   admin port, the bind address, TLS and the key file from `/etc/systemd/system/imp-aly.service`.
5. The admin port of a local server in the foreground, `http://127.0.0.1:4410`.

`-a` replaces the saved key. Without `-a` and without a saved key, the command reads the key file of
the local service, or `~/.secret/imp-aly-key`.

On the VPS, a command needs no option for the local service. Only root can read the key file of the
service, so run the command with `sudo`, such as `sudo imp-aly backup`. When the service uses TLS,
give `--url` with the host name of the certificate.

`app` and `query` take a list of saved servers, such as `-s eu-1,eu-2,eu-3`, or a group, such as
`-s prod`. A list can name groups and servers, such as `-s prod,us-1`. It must not name a server two
times. `app` runs on all servers at the same time. `query` asks all servers at the same time and
adds up their answers. When one server fails, the command continues with the others, then exits with
code

1. A server fails when it cannot be reached, when it answers with an error, when its answer is not
   JSON or not a query answer, or when it does not answer before `--timeout`. The other commands
   take one server. See [Several servers](query.md#several-servers).

`token` takes only `-s` and `-a`. It prints a one-time token for one request to the API, such as
`imp-aly token GET /status`. For a request with a body, give the file of the body. The token is
valid for 60 seconds. See [Security](security.md).

`status` prints the state of the server: the version, the start time, the data folder, the source
id, the number of apps, the number of addresses in the rate limit, the requests in progress on each
port, and the state of the storage worker. The storage state holds the number of log parts that
wait, the number of stored records since the start, the last error, and the free disk space. It also
lists the days whose records the worker keeps aside (`heldDays`), counts the log parts that it
cannot read (`unreadableSegments`), and counts the records that it could not store since the start
(`droppedRecords`). See [Storage](storage.md#a-day-that-the-worker-cannot-store).

`backup` saves the summaries of all the apps and sources of one server to a compressed file. Without
a file name, it writes `imp-aly-backup-<period>-by-<granularity>-<day>.tar.gz` in the current
folder. `--last` sets the period: `1d`, `7d`, `30d`, `3m`, `6m`, `1y` or `all` (the default). The
period ends at the last sealed day. `--by` sets the granularity: `day` (the default), `week` or
`month`. A week or a month is in the backup when it is complete and all its days are in the period.
`restore` sends such a file to the server. See [Backup](backup.md).

See [Apps](apps.md) for `app`, and [Queries](query.md) for `query`.

## Saved servers

Save the servers that you use, and give each one a name. Then a client command needs only the name.

```sh
imp-aly add eu https://eu.analytics.example -a ~/.secret/imp-aly-eu
imp-aly add us http://203.0.113.10:4410 -a ~/.secret/imp-aly-us
imp-aly query '{"app": "myapp"}'
imp-aly query '{"app": "myapp"}' -s eu
```

| Command                             | What it does                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `add <name> <url> [-a <key\|file>]` | saves a server, or replaces the server with the same name                        |
| `group <name> <a,b,c>`              | saves a group of saved servers, or replaces the group with the same name         |
| `ls [--json]`                       | lists the saved servers and groups, `*` marks the default                        |
| `use <name>`                        | makes the server or the group the default                                        |
| `rm <name>`                         | removes the server or the group. The last server in the list becomes the default |

The server that you add becomes the default server. A client command without `-s` and without
`--url` calls the default server, or the servers of the default group.

A name of a server or a group has up to 63 letters, digits, `.`, `_` and `-`. It starts with a
letter or a digit. The URL starts with `http://` or `https://`. It can have a path, for a server
behind a proxy.

`-a` takes the same values as in the other commands. For a key file, the command saves the absolute
path of the file, not the key. For a key given as text, the command saves the key. `ls` does not
show a saved key.

The command keeps the list in `~/.config/imp-aly/servers.json`, with access for the owner only. When
`XDG_CONFIG_HOME` is set, the list is in `$XDG_CONFIG_HOME/imp-aly/servers.json`.

### Groups

A group gives a name to a list of saved servers. Then `-s <group>` names all of its servers.

```sh
imp-aly group prod eu-1,eu-2,eu-3
imp-aly query report.json -s prod
imp-aly use prod
imp-aly query report.json
```

- A group holds saved servers. It cannot hold a group.
- A server and a group cannot have the same name.
- `group` does not change the default. Use `use <group>` to make the group the default.
- `rm <group>` removes the group. It does not remove the servers of the group.
- `rm` refuses a server that is in a group. Change the group with `group`, or remove the group
  first.
- `backup`, `restore`, `status` and `token` take one server. When the default is a group of two or
  more servers, give `-s <server>` to these commands.

## Console

`imp-aly console` serves the console web app on your machine, at `http://localhost:4400`. It shows
the reports of your apps in charts, and it registers and removes apps. Add the servers and their
keys in the page. The page does not use the saved servers of the CLI. `--port <port>` changes the
port. The same app is at `https://sobanieca.github.io/imp-aly/console/`, ready to install on a
phone. See [Console](console.md).

## AI agents

`imp-aly skill` prints the reference of `imp-aly help` with a short preamble for AI agents.

`imp-aly skill --init` creates a skill. Then you can ask an agent with `/imp-aly` (Claude Code,
Cursor) or `$imp-aly` (Codex):

```
/imp-aly how many visits did myapp have last week, per page
```

The command writes the same `SKILL.md` to two folders: `.agents/skills/imp-aly/` (Codex, Cursor) and
`.claude/skills/imp-aly/` (Claude Code, Cursor). It finds the location in this order:

1. The command looks for `.git` in the current folder and in each parent folder, up to your home
   folder.
2. In a git repository, the skill goes to the git root. Agents see it in all folders of the
   repository, also in the packages of a monorepo.
3. Outside a git repository, the skill goes to your home folder, such as
   `~/.claude/skills/imp-aly/`. Agents then see the skill in all projects.

The command does not replace a skill that exists. To write it again, remove the `SKILL.md` files.

The skill tells the agent to use saved servers. The agent never gets a key.

## Exit codes

A command exits with `0` on success and with `1` on an error. It prints the error on one line.
