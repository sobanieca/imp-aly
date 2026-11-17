# Temporary agent keys for AI agents

## Context

An owner asks an AI agent to read the numbers of an app or to register an app. The agent runs the
imp-aly CLI. The key of the server works without an end, and only root on the VPS can change it. An
owner who gives that key to an agent cannot take it back without a rotation, which every other
client must follow. The agent needs a key that stops by itself, and that the owner can remove at
once.

## Decision

**The owner adds named agent keys to a server. An agent key stops after 1, 4, 8 or 24 hours. It
signs tokens like the key of the server, but it cannot manage agent keys.**

- `POST /keys` takes `{"name": "...", "hours": 4}`. The hours are 1, 4, 8 or 24, and no other
  value. A short list of fixed times is simple to choose in the console and in the CLI. It needs no
  check of the clock or the time zone of the client. The server makes a random key of 32 letters
  and digits, like the key of the server, and sends it once in the answer. `GET /keys` lists the names and the times, without
  the keys. `DELETE /keys/<name>` removes a key at once.
- A name follows the rules of an app name. Each name is unique among the keys that work. A server
  keeps at most 20 agent keys. The time starts at the clock of the server.
- The token has the same form for both kinds of key. The verifier checks the signature with the key
  of the server first, then with each agent key. So the CLI and the console use an agent key as an
  ordinary key, and an agent saves it with `imp-aly add <name> <url> -a <agent key>`.
- An agent key that signs a request to `/keys` gets `403`. So an agent cannot make a key that works
  longer than its own key, and cannot remove the keys of other agents.
- A token of an agent key that expired gets `401` with the name of the key. The server drops expired
  keys at the next change, the next list and the next start.
- The server keeps the agent keys in `agent-keys.json` in the data folder, with mode `600`. A
  restart, such as an automatic update, keeps them. A backup does not hold them.
- A new key of the server, from `imp-aly key rotate` and `SIGHUP`, removes all agent keys. A person
  with a leaked key of the server could have made agent keys, and they must stop with the leaked key.
- `imp-aly key add <name> --for <1h | 4h | 8h | 24h>`, `imp-aly key ls` and `imp-aly key rm <name>`
  call these endpoints. The add command prints the key once, with the
  command for the agent.
- The console has an "Agent keys" screen. It lists the agent keys of each saved server, adds a key
  for one of the fixed times, and removes a key. It shows a new key once, in the command for the
  agent, and forgets it when its dialog closes. See `console-web-app.md`.
- The skill of `imp-aly skill` tells the agent to run the add command that the owner gives it, and to
  ask the owner for a new key when the key expired.

## Consequences

- The owner gives an agent access for a short time, and keeps the key of the server.
- During its time, an agent key can do all that the key of the server can do on the other
  endpoints: query, register and remove apps, back up and restore. A restore or a remove from an
  agent can change data.
- The agent keys are in the data folder as text. A process that can read the data folder can read
  them, as it can read the key of the server in most setups.
- Each admin request can compute up to 21 signatures when its token is wrong. HMAC-SHA256 is fast,
  so this does not slow the server.
