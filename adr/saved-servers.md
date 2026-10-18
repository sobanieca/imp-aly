# The client keeps named servers, groups of them, and a default

## Context

The same binary is the server and the client. An owner can run more than one server, for example one
per region or one per customer. Each call from a laptop needed `--url` and `-a` again. tunnelr
solves the same problem with saved connections. An owner with several servers per app gave each
`app` and `query` command the full list, such as `-s eu-1,eu-2,eu-3`.

## Decision

**`imp-aly add|group|ls|use|rm` keeps a list of named servers and named groups of them in
`~/.config/imp-aly/servers.json`. The client commands take `-s <name>` and call the default when no
server is given.**

- An entry has a name, a URL, and optionally the `-a` value. For a key file, the entry holds the
  absolute path of the file. For a key given as text, it holds the key. The file has mode `600`.
- `add` replaces an entry with the same name and makes the entry the default. `use` changes the
  default. `rm` makes the last remaining entry the default.
- A client command finds the server in this order: `--server`, `--url`, the default saved server,
  the local service, the admin port of a local server on `http://127.0.0.1:4410`. `--server` and
  `--url` together are an error. `-a` replaces the saved key.
- The local service is the systemd service on this machine. The command reads its admin port, its
  bind address, its TLS option and its key file from the unit file
  `/etc/systemd/system/imp-aly.service`, which every user can read. Only root can read the key file,
  so `sudo imp-aly backup` on the VPS needs no option. Without root, the command says to use `sudo`
  or `-a`. A service with TLS needs `--url` with the host of the certificate.
- `ls` does not show a saved key.
- `group <name> <a,b,c>` saves a group, a name for a list of saved servers. It replaces a group with
  the same name. It does not change the default. `use <group>` makes the group the default.
- A group holds only saved servers, not groups. Servers and groups share one set of names, so
  `-s <name>` has one meaning.
- `rm` removes a server or a group. It refuses a server that is in a group. Thus a group never loses
  a server without a command that names the group.
- `app` and `query` take a list of names, `-s a,b,c`. A name in the list can be a group, and the
  command replaces it with the servers of the group. The full list must not name a server two times.
  `app` and `query` ask all servers at the same time. `query` adds up the answers, see
  `several-servers-merged-by-the-client.md`. The other commands refuse a list, and a group of two or
  more servers. This also applies to a default group.
- `XDG_CONFIG_HOME` replaces `~/.config` when it is set.
- The commands are at the top level, as in tunnelr. `imp-aly server` starts the server, so the saved
  servers cannot use `server` as their command.

## Consequences

- One `add` per server, then a query needs only `-s <name>`, or nothing for the default.
- One `group` per set of servers, then a query of all of them needs only `-s <group>`. With a
  default group, it needs no option.
- With a default group, `backup`, `restore`, `status` and `token` need `-s <server>`. `group` does
  not make the group the default, so `add` and `group` together do not break these commands.
- The default is fixed until `add`, `use` or `rm` changes it. A command with `-s` does not change
  it, so a later command does not go to another server by surprise.
- On a VPS with saved servers, a command without options calls the default saved server, not the
  local service. Use `--url` and `-a` there.
- A command over SSH on the VPS, such as `sudo imp-aly backup` or `sudo imp-aly restore <file>`,
  needs no option, also with another admin port or another key file.
- The URL of a saved server is the URL of its admin port, not of its public port.
- The console page keeps its own list of servers in the browser, see `console-web-app.md`. The saved
  servers and groups of the CLI do not appear in it.
