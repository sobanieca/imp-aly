use crate::VERSION;
use crate::api_client::{CALL_TIMEOUT_MS, QUERY_TIMEOUT_MS};
use crate::console::DEFAULT_CONSOLE_PORT;
use crate::http::DEFAULT_MAX_CONNECTIONS;
use crate::rate_limit::{DEFAULT_TRUSTED_PROXIES, default_limits};
use crate::retention::DEFAULT_MIN_FREE;
use crate::server::{DEFAULT_ADMIN_PORT, DEFAULT_MAX_REQUESTS, DEFAULT_PORT};
use crate::service::SERVICE_DATA_DIR;

pub const DEFAULT_DATA_DIR: &str = "~/.imp-aly";

pub fn help_text() -> String {
    let limit_lines = default_limits()
        .iter()
        .map(|window| {
            format!(
                "{:<25}records per address in {} (default {})",
                format!("  --limit-{} <n>", window.name),
                window.name,
                window.limit
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let query_timeout = QUERY_TIMEOUT_MS / 1000;
    let call_timeout = CALL_TIMEOUT_MS / 1000;
    let trusted = DEFAULT_TRUSTED_PROXIES.join(",");
    format!(
        r#"
imp-aly {VERSION} - collect the analytics records of imp apps on your own VPS.

Usage:

  imp-aly server [options]              start the server (on the VPS)
  imp-aly server --uninstall            remove the systemd service
  imp-aly update [--check] [--auto]     install a newer version
  imp-aly key rotate [-a <file>]        change the key, and the server does not stop
  imp-aly app add <name> <app url> [--segments plan,role] [--origins <list>]
  imp-aly app ls | show <name> | refresh <name> | rm <name>
  imp-aly query '<json>' | query <file.json> [--json]
  imp-aly backup [<file>] [--last <period>] [--by day|week|month] [-s <name>]
  imp-aly restore <file>                put the summaries of a backup back
  imp-aly status
  imp-aly console [--port <port>]       serve the console, a web app with reports, on this machine
  imp-aly token <method> <path> [<body file>]   print a one-time token for one request
  imp-aly add <name> <url> [-a <key|file>]   save a server
  imp-aly group <name> <a,b,c>          save a group of saved servers
  imp-aly ls | use <name> | rm <name>   list, select or remove saved servers and groups
  imp-aly skill [--init]                print instructions for AI agents, or create a skill
  imp-aly help | version

Server (on the VPS):

  sudo imp-aly server --port {DEFAULT_PORT}

  As root on Linux with systemd, this installs (or updates) the systemd service
  "imp-aly", starts it and prints the address and the key. The service runs as
  the system user "imp-aly", which can write only the data folder. It starts
  again after a reboot. Run the same command again to see the address and the
  key. Without root or systemd, the server runs in the foreground.

  -p, --port <port>         public port for /collect (default {DEFAULT_PORT})
  --admin-port <port>       port for the private API that the client commands
                            call (default {DEFAULT_ADMIN_PORT}); open it only to your machines
  -d, --data <folder>       data folder (default {SERVICE_DATA_DIR} for the service,
                            {DEFAULT_DATA_DIR} in the foreground); each folder has its
                            own source id, so do not run a copy of a used folder
  -a, --auth <key|file>     key, or a file with the key (default
                            ~/.secret/imp-aly-key, created when missing)
  --bind <address>          listen on this address only (default: all)
  --admin-bind <address>    admin port: listen on this address only, like
                            127.0.0.1 (default: the --bind address)
  --ip-header <name>        read the client address from this header, for a server
                            behind a proxy (x-forwarded-for, cf-connecting-ip, ...)
  --trusted-proxy <list>    with --ip-header: read the header only from these
                            addresses or networks, like 10.0.0.0/8,::1
                            (default {trusted})
  --max-requests <n>        requests in progress on each port; above it, the server
                            answers 503 (default {DEFAULT_MAX_REQUESTS}); one address can
                            have 1/32 of them, then 429
  --max-connections <n>     open connections on each port; above it, the server
                            closes new connections (default {DEFAULT_MAX_CONNECTIONS}); one address
                            can have 1/32 of them, a trusted proxy has no share
  --country-header <name>   store the country from this header (cf-ipcountry, ...)
  --min-free <size>         free disk space to keep, as 10% or 5GB (default {DEFAULT_MIN_FREE});
                            the records of the oldest days are removed to keep it,
                            then their daily summaries, then the week and month
                            summaries
  --tls-cert <file>         serve HTTPS with this certificate (PEM)
  --tls-key <file>          and this private key (PEM); the server checks both files
                            once an hour and loads a renewed certificate
{limit_lines}
  --foreground              do not touch systemd, run in the foreground
  --no-auto-update          do not install the timer that updates imp-aly
  --uninstall               stop and remove the systemd service and the update timer

Connections (on each port):

  A client must send the request line and the headers in 10 seconds, at most
  16 KiB and 64 headers. An idle connection closes after 5 seconds, or after 1
  second when half of the connections are in use. A TLS handshake must end in
  10 seconds. A body for /collect must arrive in 5 seconds, a body for the
  admin API in 10 seconds, and an upload to /restore must send bytes at least
  every 30 seconds. A client that does not read an answer for 30 seconds is
  closed. These limits stop slow clients (slowloris) from holding the ports.

Updates (on the VPS):

  sudo imp-aly update                       install the newest version now
  sudo imp-aly update --auto                install what the timer installs
  imp-aly update --check                    show both, and install nothing

  "sudo imp-aly server" also installs the systemd timer "imp-aly-update". Once
  a day, at a random time, it runs "imp-aly update --auto". It installs only a
  newer version that reads the same data folder, in the same major version
  (before 1.0.0: the same minor version), that GitHub published more than 7
  days ago. Without --auto, update skips the last two rules, so it can install
  a new major version. Then run your "sudo imp-aly server" command again.
  An update never installs an older version. It checks the SHA-256 of the
  download with the SHA-256 file of the release. It replaces the binary in one step and restarts the
  service. When the service does not stay running for 15 seconds, it puts the
  old binary back, restarts the service again and does not try that version
  again. The old binary stays next to the new one, as .imp-aly.previous.
  Without the service, restart the server yourself.

Change the key (on the VPS):

  sudo imp-aly key rotate                   the service loads a new key and does not stop
  imp-aly key rotate [-a <file>]            a server in the foreground: then send it
                                            SIGHUP (kill -HUP <pid>), or start it again

  The command makes a new key, writes it to the key file and prints it. From
  then on, the server refuses each token that the old key signed. Give the new
  key to each machine that calls the server, and change it in the console.
  The API has no endpoint that changes the key.

Client commands (app, query, backup, restore, status, token):

  -s, --server <name>       a saved server (default: the default saved server);
                            app and query take a list, like -s eu-1,eu-2, or a
                            group: app runs on all servers at the same time,
                            query adds up the answers of all
  --url <url>               server URL (default: the default saved server; with no
                            saved server, the local service, or
                            http://127.0.0.1:{DEFAULT_ADMIN_PORT} when it is not installed)
  -a, --auth <key|file>     key, or a file with the key (default: the key of the
                            saved server, the key file of the local service, or
                            ~/.secret/imp-aly-key)
  --timeout <seconds>       app, query and status: wait this long for each
                            server (default {query_timeout} for query, {call_timeout} for the others);
                            a server that does not answer in time counts as failed
  --json                    print the raw JSON answer

  On the VPS, the local service needs no option: the command reads the admin
  port and the key file from the unit file of the service. Only root can
  read that key file, so run the command with sudo.

Backup (on the VPS, over SSH, or on another machine):

  sudo imp-aly backup                               all the days of the local service
  sudo imp-aly restore imp-aly-backup-all-by-day-2026-10-09.tar.gz
  imp-aly backup day.tar.gz --last 1d               the last sealed day
  imp-aly backup year.tar.gz --last 1y --by month   the months of the last year
  imp-aly backup all.tar.gz -s eu                   all the days of the server "eu"

  --last <period>           1d, 7d, 30d, 3m, 6m, 1y or all (default all); the
                            period ends at the last sealed day
  --by <granularity>        day, week or month (default day): a summary of each
                            sealed day, UTC week (Monday to Sunday) or UTC month

  Without <file>, the command writes the file
  imp-aly-backup-<period>-by-<granularity>-<day>.tar.gz in the current folder.
  A backup holds all the apps and all the sources of one server. A week or a
  month is in the backup when it is complete and its last day is in the
  period. A day is sealed at 01:10 UTC of the next day. A restored week
  answers a query by week or with no time, and a restored month a query by
  month or with no time. A query by day skips them.

Apps:

  imp-aly app add myapp https://myapp.example/
  imp-aly app add myapp https://myapp.example/ --segments plan

  imp build writes app-analytics.json at the root of the build output. The
  server stores a record only when its page, zone and outcome name are in the
  lists of this file. The URL is the folder where the build is served. The
  server reads the file there at once and again every 10 minutes. Run
  "app refresh" after each deploy.

  An app accepts records only from the browser pages of its origins. The
  default is the origin of the URL. Give others with --origins, like
  --origins https://myapp.example,https://www.myapp.example.
  The server answers 403 to a page of another origin.

Saved servers (on your machine):

  imp-aly add eu https://eu.analytics.example -a ~/.secret/imp-aly-eu
  imp-aly add us http://203.0.113.10:4410 -a ~/.secret/imp-aly-us
  imp-aly query '{{"app": "myapp"}}'          ask the default server (now "us")
  imp-aly query '{{"app": "myapp"}}' -s eu    ask "eu"
  imp-aly use eu                            make "eu" the default
  imp-aly ls                                list the servers, "*" marks the default
  imp-aly rm us                             remove one
  imp-aly query '{{"app": "myapp"}}' -s eu,us ask both and add up the answers
  imp-aly group all eu,us                   save the group "all" of eu and us
  imp-aly query '{{"app": "myapp"}}' -s all   ask the servers of the group
  imp-aly use all                           make the group the default
  imp-aly rm all                            remove the group, not its servers

  "add" replaces a server with the same name and makes it the default. A path
  to the key file is saved, not the key. A key given as text is saved as it is.
  "group" replaces a group with the same name and does not change the default.
  A group holds saved servers, not groups. A server and a group cannot have
  the same name. "rm" refuses a server that is in a group. When the default is
  a group, backup, restore, status and token need -s <server>.
  The list is in ~/.config/imp-aly/servers.json ($XDG_CONFIG_HOME when set).

Queries (how the server reads the data):

  A query reads a sealed day, week or month from its summary when it can,
  and scans the records of the day otherwise. The server keeps the summaries
  that it read in memory (up to 256 MB) and checks the folders on the disk
  before each use, so the same report again reads almost nothing. A scan
  reads the files in blocks, so its memory does not grow with the day. A
  query reads its days on all the cores, one query at a time. The
  current day has a running summary in memory, which the server makes again
  from the records of the day after a start.

Console (a web app for your phone or your machine):

  https://sobanieca.github.io/imp-aly/console/   open it, and install it from the browser
  imp-aly console                           serve it on http://localhost:{DEFAULT_CONSOLE_PORT}
  imp-aly console --port 9000               on another port

  The console is a web app with reports on the visits, the pages, the
  zones, the outcomes and the errors, and pages for the apps and the
  servers. It asks each server for its apps, and a report asks the servers
  that have the app. It calls the admin ports of the servers directly.
  Make backups with the CLI. Add each server with its URL and its key in
  the page. The page keeps the keys in the browser, and no script can read them back.
  An installed console on https needs servers with https.
  "imp-aly console" listens on 127.0.0.1 and ::1 only. Stop it with Ctrl+C.

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
  PUT  /apps/<name>         key: {{"appUrl": "..."}}, optional "segments" and "origins"
  GET  /apps/<name>         key: one app with its rejection counts
  POST /apps/<name>/refresh key: read app-analytics.json again
  DELETE /apps/<name>       key: stop accepting records of the app
  POST /query               key: a query, answers the counts per group (docs/query.md)
  GET  /backup              key: the summaries as .tar.gz, ?last=<period>&by=<granularity>
  POST /restore             key: a backup file, see docs/backup.md

  "key" endpoints take "Authorization: Bearer <token>", where the token comes
  from "imp-aly token <method> <path> [<body file>]". A token works once, for
  60 seconds, and only for that method, path (with its query) and body. Send
  the body file as it is, with curl --data-binary.
"#
    )
}

pub fn help() {
    println!("{}", help_text());
}
