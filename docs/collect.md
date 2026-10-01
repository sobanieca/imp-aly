# imp-analytics-server - Collecting records

Your app sends its records to one public endpoint:

```
POST /collect/<app>
```

`<app>` is the name of a registered app. The body is one record, or a JSON array of up to 100
records. That is the shape that `batch` of `imp/analytics` sends. The content type can be any value,
so `navigator.sendBeacon` with a string body works.

The server answers `202` with the counts:

```json
{ "accepted": 19, "rejected": 1 }
```

The server stores the accepted records before it answers. A rejected record does not stop the other
records of the same request.

## The records

The server accepts the five record types of imp, with the fields that imp gives them:

| `type`        | Fields                                |
| ------------- | ------------------------------------- |
| `page`        | `visit`, `at`, `page`, `readyMs`      |
| `seen`        | `visit`, `at`, `page`, `zone`         |
| `interaction` | `visit`, `at`, `page`, `zone` or null |
| `outcome`     | `visit`, `at`, `page`, `name`         |
| `error`       | `visit`, `at`, `page`                 |

A record can also carry the segments that you declare for the app, such as `plan`. See
[Apps](apps.md).

## The checks

Anyone can post to a public endpoint. So the server checks each record, and drops the record when
one check fails:

- The record is a JSON object.
- `type` is one of the five types.
- The record has no field other than the fields of its type and the declared segments.
- `visit` is an id of 1 to 64 letters, digits, `-` or `_`.
- `at` is a whole number of milliseconds since the epoch, in UTC. It is at most 24 hours before the
  time of the server and at most 1 hour after it.
- `page` is a line of the app map. A path such as `/invoices/42` is not a pattern, so it fails.
- `readyMs` is a number from 0 to 3600000. The server rounds it to a whole number.
- `zone` and `name` are namespaced names, such as `myapp.send`, of up to 128 characters.
- A segment value is null, or a text of up to 64 characters, a number or a boolean. The server
  stores a number and a boolean as text. An empty text is null.
- No value contains a control character, such as a line break or a tab.

The server counts the rejected records of each app by reason. `imp-analytics-server app show myapp`
prints the counts. A record that your app sends and the server rejects is a bug in the sink, so
check the counts after you deploy a change of the sink.

The day of a record is the UTC day of its `at`. One request can hold records of two days, for
example a batch that the browser sends just after midnight UTC. Each record goes to its own day.

The window of `at` stops a sender from writing into old or future days. A browser whose clock is
wrong by more than the window loses its records, and the rejection counts of the app show
`at is more than 24 hours old` or `at is more than 1 hour ahead`.

## Limits of a request

| Limit                  | Value  | Answer |
| ---------------------- | ------ | ------ |
| body size              | 64 KiB | `413`  |
| records in one request | 100    | `413`  |
| time to send the body  | 10 s   | `408`  |
| body that is not JSON  |        | `400`  |
| app that is not known  |        | `404`  |

The browser limits a `sendBeacon` body to about 64 KiB. 20 records are about 2 KB.

## Rate limit per address

The server counts the records of each client address in four windows. A request that holds no record
counts as one. When an address reaches the limit of a window, the server answers `429` at once and
does not read the body. When the records of one request take the address over a limit, the server
answers `429` and stores none of them.

| Window | Default limit | Option        |
| ------ | ------------- | ------------- |
| 5 s    | 200           | `--limit-5s`  |
| 1 min  | 1,500         | `--limit-1m`  |
| 1 h    | 30,000        | `--limit-1h`  |
| 24 h   | 200,000       | `--limit-24h` |

The defaults let one address send the records of a small office of active people. One active tab of
an imp app sends about 70 records a minute: one `interaction` per zone per 5 seconds, plus the
`page` and `seen` records of each navigation. Raise the limits when many people share one address,
such as the users of a large company network.

A window slides. The server weighs the count of the previous window by the part of it that is still
inside the window. So an address cannot double its limit at the edge of a window.

The server keeps the counts of the 100,000 most recent addresses in memory, and nothing on disk. A
restart clears the counts. IPv6 addresses count per `/64` network, because one host can use any
address of its `/64`.

## Behind a proxy

Behind a proxy, every request comes from the address of the proxy. Tell the server which header
holds the address of the client:

```sh
sudo imp-analytics-server --port 2980 --ip-header x-forwarded-for
```

The server takes the last address of the header, which is the address that your proxy added. Use
`cf-connecting-ip` behind Cloudflare, or `x-real-ip` when your proxy sets it.

**Do not set `--ip-header` when clients reach the server directly.** A client can then put any
address in the header, and so it escapes the rate limit.

## Country

The server can store the country of each record from a header of your CDN or proxy:

```sh
sudo imp-analytics-server --port 2980 --country-header cf-ipcountry
```

The server stores a two-character code, such as `PL`, in the field `country`. It stores null when
the header is missing or holds another value. The server never stores the address of a client.

## CORS

The endpoint allows requests from every origin. It answers the preflight `OPTIONS` request of a
`fetch` with `content-type: application/json`. `sendBeacon` with a string body sends no preflight.

The origin is not a check. A client outside a browser can send any `Origin` header. The app map, the
record checks and the rate limit protect the endpoint.
