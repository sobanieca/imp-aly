import { DEFAULT_LIMITS, DEFAULT_TRUSTED_PROXIES } from '../rate-limit.js'
import { DEFAULT_MIN_FREE } from '../retention.js'
import { DEFAULT_CONSOLE_PORT } from '../console.js'
import { DEFAULT_ADMIN_PORT, DEFAULT_MAX_REQUESTS, DEFAULT_PORT } from '../server.js'
import { version } from '../version.js'
import { SERVICE_DATA_DIR } from '../service.js'
import { DEFAULT_DATA_DIR } from './server.js'

const limitLines = DEFAULT_LIMITS.map((window) =>
  `  --limit-${window.name} <n>`.padEnd(25) +
  `records per address in ${window.name} (default ${window.limit})`
).join('\n')

export const helpText = () => `
imp-aly ${version} - collect the analytics records of imp apps on your own VPS.

Usage:

  imp-aly server [options]              start the server (on the VPS)
  imp-aly server --uninstall            remove the systemd service
  imp-aly app add <name> <app url|build folder> [--segments plan,role]
  imp-aly app ls | show <name> | refresh <name> | rm <name>
  imp-aly query '<json>' | query <file.json> [--json]
  imp-aly backup <file> [--app <name>] [--from <day>] [--to <day>]
  imp-aly restore <file>                put the summaries of a backup back
  imp-aly status
  imp-aly console [--port <port>]       open the console, a web page with reports, on this machine
  imp-aly token <method> <path> [<body file>]   print a one-time token for one request
  imp-aly add <name> <url> [-a <key|file>]   save a server
  imp-aly ls | use <name> | rm <name>   list, select or remove saved servers
  imp-aly skill [--init]                print instructions for AI agents, or create a skill
  imp-aly help | version

Server (on the VPS):

  sudo imp-aly server --port ${DEFAULT_PORT}

  As root on Linux with systemd, this installs (or updates) the systemd service
  "imp-aly", starts it and prints the address and the key. The service runs as
  the system user "imp-aly", which can write only the data folder. It starts
  again after a reboot. Run the same command again to see the address and the
  key. Without root or systemd, the server runs in the foreground.

  -p, --port <port>         public port for /collect (default ${DEFAULT_PORT})
  --admin-port <port>       port for the private API that the client commands
                            call (default ${DEFAULT_ADMIN_PORT}); open it only to your machines
  -d, --data <folder>       data folder (default ${SERVICE_DATA_DIR} for the service,
                            ${DEFAULT_DATA_DIR} in the foreground)
  -a, --auth <key|file>     key, or a file with the key (default
                            ~/.secret/imp-aly-key, created when missing)
  --bind <address>          listen on this address only (default: all)
  --admin-bind <address>    admin port: listen on this address only, like
                            127.0.0.1 (default: the --bind address)
  --ip-header <name>        read the client address from this header, for a server
                            behind a proxy (x-forwarded-for, cf-connecting-ip, ...)
  --trusted-proxy <list>    with --ip-header: read the header only from these
                            addresses or networks, like 10.0.0.0/8,::1
                            (default ${DEFAULT_TRUSTED_PROXIES.join(',')})
  --max-requests <n>        requests in progress on each port; above it, the server
                            answers 503 (default ${DEFAULT_MAX_REQUESTS})
  --country-header <name>   store the country from this header (cf-ipcountry, ...)
  --allow-origin <list>     accept records only from these browser origins, like
                            https://myapp.example,https://www.myapp.example
                            (default: every origin)
  --min-free <size>         free disk space to keep, as 10% or 5GB (default ${DEFAULT_MIN_FREE});
                            the records of the oldest days are removed to keep it,
                            and then their daily summaries
  --tls-cert <file>         serve HTTPS with this certificate (PEM)
  --tls-key <file>          and this private key (PEM); the server checks both files
                            once an hour and loads a renewed certificate
${limitLines}
  --foreground              do not touch systemd, run in the foreground
  --uninstall               stop and remove the systemd service

Client commands (app, query, backup, restore, status, token):

  -s, --server <name>       a saved server (default: the default saved server);
                            app and query take a list, like -s eu-1,eu-2: app runs
                            on each server, query adds up the answers of all
  --url <url>               server URL (default: the default saved server, or
                            http://127.0.0.1:${DEFAULT_ADMIN_PORT} when no server is saved)
  -a, --auth <key|file>     key, or a file with the key (default: the key of the
                            saved server, or ~/.secret/imp-aly-key)
  --json                    print the raw JSON answer
  --app <name>              backup: only this app (default: all)
  --from <day>, --to <day>  backup: only these days, as YYYY-MM-DD

Apps:

  imp-aly app add myapp https://myapp.example/      the server reads the file
  imp-aly app add myapp dist --segments plan        upload the file of dist

  imp build writes app-analytics.json at the root of the build output. The
  server stores a record only when its page, zone and outcome name are in the
  lists of this file. With a URL, the server reads the file in that folder at
  once and again every 10 minutes. With a folder, the command uploads the file.
  Run "app refresh" or "app add" after each deploy.

Saved servers (on your machine):

  imp-aly add eu https://eu.analytics.example -a ~/.secret/imp-aly-eu
  imp-aly add us http://203.0.113.10:2981 -a ~/.secret/imp-aly-us
  imp-aly query '{"app": "myapp"}'          ask the default server (now "us")
  imp-aly query '{"app": "myapp"}' -s eu    ask "eu"
  imp-aly use eu                            make "eu" the default
  imp-aly ls                                list the servers, "*" marks the default
  imp-aly rm us                             remove one
  imp-aly query '{"app": "myapp"}' -s eu,us ask both and add up the answers

  "add" replaces a server with the same name and makes it the default. A path
  to the key file is saved, not the key. A key given as text is saved as it is.
  The list is in ~/.config/imp-aly/servers.json ($XDG_CONFIG_HOME when set).

Console (on your machine):

  imp-aly console                           start the console on http://localhost:${DEFAULT_CONSOLE_PORT}
  imp-aly console --port 9000               on another port

  The console is a web page with reports on the visits, the pages, the
  zones, the outcomes and the errors, a query builder, and pages for the
  apps, the saved servers and the backups. It uses the saved servers and
  their keys, like the client commands. The key never goes to the browser.
  It listens on 127.0.0.1 and ::1 only. Stop it with Ctrl+C.

AI agents:

  imp-aly skill                             print this help with a short preamble for agents
  imp-aly skill --init                      create the skill /imp-aly (Claude Code, Cursor)
                                            and $imp-aly (Codex)

  "skill --init" writes .agents/skills/imp-aly/SKILL.md and
  .claude/skills/imp-aly/SKILL.md. In a git repository (the command looks for
  .git from the current folder up to the home folder), the files go to the git
  root, so agents see the skill in all folders of the repository. Outside a git
  repository, the files go to the home folder, so agents see the skill in all
  projects. The command does not replace a skill that exists.

API:

  POST /collect/<app>       public: a record or an array of records, up to 64 KiB
  GET  /                    public: the name and the version
  GET  /status              key: the state of the server
  GET  /apps                key: the registered apps
  PUT  /apps/<name>         key: {"appUrl": "..."} or {"build": "<app-analytics.json>"},
                            optional "segments"
  GET  /apps/<name>         key: one app with its rejection counts
  POST /apps/<name>/refresh key: read app-analytics.json again
  DELETE /apps/<name>       key: stop accepting records of the app
  POST /query               key: a query, answers the counts per group (docs/query.md)
  GET  /backup              key: the daily summaries as .tar.gz, ?app=&from=&to=
  POST /restore             key: a backup file, see docs/backup.md

  "key" endpoints take "Authorization: Bearer <token>", where the token comes
  from "imp-aly token <method> <path> [<body file>]". A token works once, for
  60 seconds, and only for that method, path (with its query) and body. Send
  the body file as it is, with curl --data-binary.
`

export const help = () => console.log(helpText())
