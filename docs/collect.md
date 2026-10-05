# imp-aly - Collecting records

Your app sends its records to one public endpoint:

```
POST /collect/<app>
```

`<app>` is the name of a registered app. The body is one record, or a JSON array of records, of up
to 64 KiB. That is the shape that `alySink` of `imp/analytics/aly` sends. The content type can be
any value, so a `fetch` or a `navigator.sendBeacon` with a string body works.

The server answers `202` with the counts:

```json
{ "accepted": 19, "rejected": 1 }
```

The server stores the accepted records before it answers. A rejected record does not stop the other
records of the same request.

## The records

The server accepts the five record types of imp, with the fields that imp gives them:

| `type`    | Fields                                | One record per                                |
| --------- | ------------------------------------- | --------------------------------------------- |
| `page`    | `visit`, `at`, `page`                 | page view                                     |
| `seen`    | `visit`, `at`, `page`, `zone`         | zone that comes into view, once per page view |
| `used`    | `visit`, `at`, `page`, `zone` or null | zone that a person uses, once per page view   |
| `outcome` | `visit`, `at`, `page`, `name`         | outcome that the app reports                  |
| `error`   | `visit`, `at`, `page`                 | 5 seconds of failures on a page               |

A person uses a zone with a click, a tap, a key or an input in it. A `used` record with a null
`zone` means that the person used the page at all. So `used` divided by `seen` is the share of the
page views where a person used a zone after it came into view.

A record can also carry the segments that you declare for the app, such as `plan`. See
[Apps](apps.md).

## The checks

Anyone can post to a public endpoint. So the server checks each record, and drops the record when
one check fails:

- The record is a JSON object.
- `type` is one of the five types.
- The record has no field other than the fields of its type and the declared segments.
- `visit` is an id of 1 to 64 letters, digits, `-` or `_`.
- `at` is a whole number of milliseconds since the epoch, in UTC. It is at most 1 hour before the
  time of the server and at most 1 hour after it.
- `page` is in the `pages` of `app-analytics.json`. A path such as `/invoices/42` is not a pattern,
  so it fails.
- `zone` and `name` are namespaced names, such as `myapp.send`, of up to 128 characters. A name has
  two or more parts with a `.` between them. A part has only ASCII letters, digits, `-` and `_`.
- The `zone` of a `seen` record is in the `zones` of `app-analytics.json`. The `zone` of a `used`
  record is null or in `zones`.
- The `name` of an `outcome` record is in the `outcomes` of `app-analytics.json`.
- A segment value is null, a text, a number or a boolean. The server stores a number and a boolean
  as text. An empty text is null. The text has 1 to 64 ASCII letters, digits, `.`, `-` or `_`. For
  example, `pro`, `en-US`, `1.2.3`, `-1` and `true` pass. `1e+21`, `NaN`, `free trial` and `Krakow`
  fail.

These rules keep each stored value to plain characters. A value cannot hold HTML, a shell command, a
quote, a space, a control character or other Unicode text. So a value cannot change the look of a
terminal or a page that shows it, and it cannot change the layout of the data files.

The server counts the rejected records of each app by reason. `imp-aly app show myapp` prints the
counts. A record that your app sends and the server rejects is a bug in the sink, or a sign that the
server has an old build file. Check the counts after each deploy. See
[Update the build file after a deploy](apps.md#update-the-build-file-after-a-deploy). `alySink` also
logs a warning in the browser console when the server rejects records.

The day of a record is the UTC day of its `at`. One request can hold records of two days, for
example a batch that the browser sends just after midnight UTC. Each record goes to its own day.

The window of `at` stops a sender from writing into old or future days. A browser whose clock is
wrong by more than the window loses its records, and the rejection counts of the app show
`at is more than 1 hour old` or `at is more than 1 hour ahead`.

## Limits of a request

| Limit                  | Value                              | Answer |
| ---------------------- | ---------------------------------- | ------ |
| body size              | 64 KiB                             | `413`  |
| records in one request | the 5 s rate limit, 200 by default | `413`  |
| time to send the body  | 10 s                               | `408`  |
| body that is not JSON  |                                    | `400`  |
| app that is not known  |                                    | `404`  |
| requests in progress   | 1,024 on the public port           | `503`  |

The browser limits the body of a `keepalive` request or a `sendBeacon` to about 64 KiB. 20 records
are about 2 KB. One request holds at most as many records as the smallest window of the rate limit
allows. A larger request can never pass the rate limit, so the server answers `413` at once. Send a
large batch in parts.

## Rate limit per address

The server counts the records of each client address in four windows. A request that holds no record
counts as one. When an address reaches the limit of a window, the server answers `429` at once and
does not read the body. When the records of one request take the address over a limit, the server
answers `429` and stores none of them. These records do not count, so a smaller request can pass
after it.

| Window | Default limit | Option        |
| ------ | ------------- | ------------- |
| 5 s    | 200           | `--limit-5s`  |
| 1 min  | 1,500         | `--limit-1m`  |
| 1 h    | 30,000        | `--limit-1h`  |
| 24 h   | 200,000       | `--limit-24h` |

The defaults let one address send the records of a small office of active people. One active tab of
an imp app sends about 20 records a minute: for each page view, one `page` record, and at most one
`seen` and one `used` record per zone. Raise the limits when many people share one address, such as
the users of a large company network.

A window slides. The server weighs the count of the previous window by the part of it that is still
inside the window. So an address cannot double its limit at the edge of a window.

IPv6 addresses count per `/64` network, because one host can use any address of its `/64`. Each
`/48` network also has a limit of 16 times the limit of one address. A provider often gives one
customer a full `/48`. So one customer cannot get 65,536 separate limits.

The server keeps the counts of the 400,000 most recent addresses in memory, about 50 MB. It keeps
nothing on disk. A restart clears the counts. The server keeps the addresses in two groups of
200,000. When the newer group is full, the server forgets the older group and starts a new group. An
address that sends again stays in the newer group.

## Requests in progress

The server works on at most 1,024 requests at one time on the public port. Above this number, it
answers `503` with `retry-after: 5` at once. The admin port has a separate limit of the same size.
This limit protects the memory and the processor of the server during a flood of requests from many
addresses. `--max-requests <n>` changes it.

## Behind a proxy

Behind a proxy, every request comes from the address of the proxy. Tell the server which header
holds the address of the client:

```sh
sudo imp-aly server --port 2980 --ip-header x-forwarded-for
```

The server takes the last address of the header, which is the address that your proxy added. Use
`cf-connecting-ip` behind Cloudflare, or `x-real-ip` when your proxy sets it.

The server reads the header only when the request comes from a trusted proxy. By default, it trusts
only the same machine: `127.0.0.0/8` and `::1`. When your proxy runs on another machine, give its
addresses or networks:

```sh
sudo imp-aly server --port 2980 --ip-header x-forwarded-for --trusted-proxy 10.0.0.5,10.1.0.0/16
```

A request from any other address counts for the address of its connection. So a client that connects
directly cannot put a false address in the header to escape the rate limit.

**Do not trust a network that clients can send from.** A client in that network can put any address
in the header, and so it escapes the rate limit.

## Country

The server can store the country of each record from a header of your CDN or proxy:

```sh
sudo imp-aly server --port 2980 --country-header cf-ipcountry
```

The server stores a two-character code, such as `PL`, in the field `country`. It stores null when
the header is missing or holds another value. The server never stores the address of a client.

## CORS and allowed origins

By default, the endpoint accepts requests from every origin and answers with
`access-control-allow-origin: *`. It answers the preflight `OPTIONS` request of a `fetch` with
`content-type: application/json`. `alySink` and `sendBeacon` send a string body, so the browser
sends no preflight.

To accept records only from the pages of your apps, give their origins:

```sh
sudo imp-aly server --port 2980 --allow-origin https://myapp.example,https://www.myapp.example
```

An origin is a scheme, a host and an optional port, like `https://myapp.example` or
`http://localhost:5173`. It has no path and no `/` at the end. With `--allow-origin`, the server
does this for `/collect/<app>`:

- A request from an allowed origin gets `access-control-allow-origin` with that origin.
- A request with another `Origin` header gets `403`, also a preflight. This includes `Origin: null`.
  The server does not read the body.
- A request without an `Origin` header passes. A browser always sends the header with a `POST`.

`alySink` sends the `Origin` header, and a `Referer` header with the origin only. When the origin of
the page is not allowed, the server answers `403`. The browser hides this answer from the sink, so
the sink tries the next server.

The check stops a script on another site from sending records to your server from the browsers of
its visitors. Many browsers can come from many addresses, so the rate limit alone cannot stop them.

**A client outside a browser can send any `Origin` header.** The check does not stop such a client.
The build file, the record checks and the rate limit protect the endpoint from it.
