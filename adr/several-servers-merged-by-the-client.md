# Several servers hold separate visits, and the client adds up their answers

## Context

One VPS has a limit of disk, CPU and network. A large app needs more than one server. The servers
must not share a disk, a database or a network protocol, because each server is one binary with one
data folder. The owner still wants one report over all the records.

A count of records adds up across servers. A count of distinct visits adds up only when no visit has
records on two servers. A percentile does not add up: the mean of the p75 of each server is not the
p75 of all the records.

imp makes one random visit id per document load. A reload starts a new visit. imp keeps no cookie
and nothing in `localStorage` or `sessionStorage`.

## Decision

**Each server stores the visits that reach it. The imp app picks one server per document load and
sends every record of that visit to it. `imp-aly query -s a,b,c` asks all servers at the same time,
and adds up the counts of each group.**

- The sink of the app has a list of servers. It picks one at random when the document loads, and
  keeps it for the whole visit. So the visits of two servers never overlap, and `visits` adds up
  exactly.
- When the chosen server fails, the sink can change to another server, and keeps the new one for the
  rest of the visit. Only such a visit has records on two servers, and it counts twice.
- The servers do not know each other. There is no proxy, no coordinator and no replication.
- A server answers a query with counts, not with measures: `records`, `visits`, and the `readyMs`
  count, sum, minimum, maximum and buckets of each group. The client adds them, then calculates the
  measures. So the answer of N servers equals the answer of one server with all the records. A test
  splits the visits of a fixture over two data folders and checks this for every query.
- A server that fails does not stop the query. The client prints the result of the other servers,
  lists the failed server, and exits with code 1.
- The answer of a server has a hash of the app map and the segments. The client warns when the
  hashes differ. `app` takes a list of servers, so one command registers the app on all of them.
- **imp-aly does not count returning users, and it will not.** A returning user needs an id that
  lives longer than one document load, in a cookie or in `localStorage`. This is a deliberate
  trade-off, for two reasons:
  - Such an id spreads one user over all servers. A count of distinct users then does not add up
    across servers, and the client cannot merge it without an estimate.
  - Such an id is personal data. With it, the app needs a consent banner, and imp promises that it
    does not need one.

## Consequences

- The owner adds capacity by adding a server and its address to the list in the app. Each server
  reads only its records, so a query of 3 servers takes about one third of the time.
- A failover in the middle of a visit counts that visit twice. The docs state it.
- The report has no returning users, no retention cohorts and no count of distinct users. `visits`
  counts document loads, per day.
- Each server keeps its own app registry, key and backups. The owner registers each app on every
  server.
- A caller of the API must add up the counts and calculate the measures itself.
