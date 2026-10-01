import { DEFAULT_LIMITS } from '../rate-limit.js'
import { DEFAULT_MIN_FREE } from '../retention.js'
import { DEFAULT_PORT } from '../server.js'
import { version } from '../version.js'
import { DEFAULT_DATA_DIR } from './serve.js'

const limitLines = DEFAULT_LIMITS.map((window) =>
  `  --limit-${window.name} <n>`.padEnd(25) +
  `records per address in ${window.name} (default ${window.limit})`
).join('\n')

export const helpText = () => `
imp-analytics-server ${version} - collect the analytics records of imp apps on your own VPS.

Usage:

  imp-analytics-server [options]                     start the server
  imp-analytics-server --uninstall                   remove the systemd service
  imp-analytics-server app add <name> <map url|file> [--segments plan,role]
  imp-analytics-server app ls | show <name> | refresh <name> | rm <name>
  imp-analytics-server query '<json>' | query <file.json> [--json]
  imp-analytics-server status
  imp-analytics-server token                         print a one-time token for the API
  imp-analytics-server help | version

Server:

  sudo imp-analytics-server --port ${DEFAULT_PORT}

  As root on Linux with systemd, this installs (or updates) the systemd service
  "imp-analytics-server", starts it and prints the address and the key. The
  service starts again after a reboot. Run the same command again to see the
  address and the key. Without root or systemd, the server runs in the foreground.

  -p, --port <port>         port to listen on (default ${DEFAULT_PORT})
  -d, --data <folder>       data folder (default ${DEFAULT_DATA_DIR})
  -a, --auth <key|file>     key, or a file with the key (default
                            ~/.secret/imp-analytics-server-key, created when missing)
  --bind <address>          listen on this address only (default: all)
  --ip-header <name>        read the client address from this header, for a server
                            behind a proxy (x-forwarded-for, cf-connecting-ip, ...)
  --country-header <name>   store the country from this header (cf-ipcountry, ...)
  --min-free <size>         free disk space to keep, as 10% or 5GB (default ${DEFAULT_MIN_FREE});
                            the oldest days are removed to keep it
  --tls-cert <file>         serve HTTPS with this certificate (PEM)
  --tls-key <file>          and this private key (PEM)
${limitLines}
  --foreground              do not touch systemd, run in the foreground
  --uninstall               stop and remove the systemd service

Client commands (app, query, status, token):

  --url <url>               server URL (default http://127.0.0.1:${DEFAULT_PORT})
  -a, --auth <key|file>     key, or a file with the key (default
                            ~/.secret/imp-analytics-server-key)
  --json                    print the raw JSON answer

API:

  POST /collect/<app>       public: a record or an array of up to 100 records
  GET  /                    public: the name and the version
  GET  /status              key: the state of the server
  GET  /apps                key: the registered apps
  PUT  /apps/<name>         key: {"mapUrl": "..."} or {"map": "..."}, optional "segments"
  GET  /apps/<name>         key: one app with its rejection counts
  POST /apps/<name>/refresh key: read the app map again
  DELETE /apps/<name>       key: stop accepting records of the app
  POST /query               key: a query, see docs/query.md

  "key" endpoints take "Authorization: Bearer <token>", where the token comes
  from "imp-analytics-server token". A token works once, for 60 seconds.
`

export const help = () => console.log(helpText())
