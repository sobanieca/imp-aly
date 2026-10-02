# Named groups of saved servers

`imp-aly add` saves one server. With several servers, each `app` and `query` command needs the full
list, such as `-s eu-1,eu-2,eu-3`.

Add a named group to the saved servers, for example `imp-aly group prod eu-1,eu-2,eu-3`, so that
`-s prod` names the list. A group can be the default. Update `adr/saved-servers.md`, `docs/cli.md`
and `imp-aly help`.
