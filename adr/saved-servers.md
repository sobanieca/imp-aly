# The client keeps a list of named servers and a default

## Context

The same binary is the server and the client. An owner can run more than one server, for example one
per region or one per customer. Each call from a laptop needed `--url` and `-a` again. tunnelr
solves the same problem with saved connections.

## Decision

**`imp-aly add|ls|use|rm` keeps a list of named servers in `~/.config/imp-aly/servers.json`. The
client commands take `-s <name>` and call the default server when no server is given.**

- An entry has a name, a URL, and optionally the `-a` value. For a key file, the entry holds the
  absolute path of the file. For a key given as text, it holds the key. The file has mode `600`.
- `add` replaces an entry with the same name and makes the entry the default. `use` changes the
  default. `rm` makes the last remaining entry the default.
- A client command finds the server in this order: `--server`, `--url`, the default saved server,
  the admin port of the local server on `http://127.0.0.1:2981`. `--server` and `--url` together are
  an error. `-a` replaces the saved key.
- `ls` does not show a saved key.
- `app` and `query` take a list of names, `-s a,b,c`. `app` runs on each server in turn. `query`
  asks all servers at the same time and adds up the answers, see
  `several-servers-merged-by-the-client.md`. The other commands refuse a list.
- `XDG_CONFIG_HOME` replaces `~/.config` when it is set.
- The commands are at the top level, as in tunnelr. `imp-aly server` starts the server, so the saved
  servers cannot use `server` as their command.

## Consequences

- One `add` per server, then a query needs only `-s <name>`, or nothing for the default.
- The default is fixed until `add`, `use` or `rm` changes it. A command with `-s` does not change
  it, so a later command does not go to another server by surprise.
- On a VPS with saved servers, a command without options calls the default saved server, not the
  local server. Use `--url http://127.0.0.1:2981` there.
- The URL of a saved server is the URL of its admin port, not of its public port.
- The console page keeps its own list of servers in the browser, see `console-web-app.md`. The saved
  servers of the CLI do not appear in it.
