# imp-aly - Apps

The server accepts records only for a registered app. An app has a name, an app map and an optional
list of segments.

## Register an app

```sh
imp-aly app add myapp https://myapp.example/app-map.txt
imp-aly app add myapp dist/app-map.txt --segments plan,role
```

- **The name** is 1 to 63 lowercase letters, digits and `-`, and starts with a letter or a digit.
  The app sends its records to `/collect/<name>`.
- **The app map** is the `app-map.txt` file that `imp build` writes: one route pattern per line,
  such as `/invoices/:id`. Give a URL or a file.
  - With a URL, the server reads the map at once and again every 10 minutes. When a read fails, the
    server keeps the last map and shows the error in `app ls`.
  - With a file, the command uploads the text. The server keeps it until you upload a new one.
- **The segments** are the extra fields that your sink adds to each record, such as `plan`. See
  [Segments](#segments).

`app add` replaces an app of the same name. The counts of accepted and rejected records stay.

With several servers, give all of them to each `app` command, so that each server has the same map
and the same segments:

```sh
imp-aly app add myapp https://myapp.example/app-map.txt -s eu-1,eu-2,eu-3
imp-aly app refresh myapp -s eu-1,eu-2,eu-3
imp-aly app ls -s eu-1,eu-2,eu-3
```

See [Several servers](query.md#several-servers).

When the map cannot be read, or a line of it does not start with `/`, the command fails and the
server keeps the previous state.

## Update the map after a deploy

A new screen in your app is a new line in its map. Until the server knows the new line, it rejects
the records of that screen. So update the map in the same pipeline that deploys the app:

```sh
imp-aly app refresh myapp
```

`refresh` reads the URL of the map again. For an uploaded map, run `app add` with the new file.

## Other commands

```sh
imp-aly app ls             # every app, with its counts
imp-aly app show myapp     # one app, with its rejections by reason
imp-aly app rm myapp       # stop accepting records of the app
```

`app rm` keeps the stored records. A query of the app name still reads them, and the retention
removes them when the disk needs space. When you register the name again, its old records are part
of its data again.

The counts of accepted and rejected records live in memory. A restart sets them to zero.

## Segments

A segment describes a group of people, such as their plan, their role, their language or the version
of the app. The `segments` option of `alySink` adds it to each record:

```js
const user = useState(self, 'myapp.user')

onAnalytics(
  self,
  alySink({
    app: 'myapp',
    servers: ['https://analytics.myapp.example'],
    segments: () => ({ plan: user.get()?.plan ?? null }),
  }),
)
```

Register the sink in the `setup` of the component that holds the state, so it can read the state.
See [Segments](https://github.com/sobanieca/imp-ui/blob/main/docs/analytics.md#segments) in the imp
docs.

Declare each segment when you register the app. The server rejects a record that has a field that
the app does not declare. This keeps a typo or a forged field out of the data.

- A segment name is 1 to 32 letters and digits, and starts with a letter.
- These names are reserved, in any case: `type`, `visit`, `at`, `page`, `readyMs`, `zone`, `name`,
  `country`, `day`, `records` and `visits`.
- Two segment names of one app must differ in more than the case, such as `plan` and `Plan`. Some
  file systems do not tell them apart.
- An app has at most 16 segments.
- A segment value is null, a number, a boolean, or a text of 1 to 64 ASCII letters, digits, `.`, `-`
  or `_`. Use values such as `pro`, `en-US` or `1.2.3`. See [Collecting records](collect.md).

**Do not put personal data in a segment.** A user id, an email address or an organization id is
personal data, also when you hash it. Add groups, not ids.

## The API

The commands call these endpoints. Each one needs a token, see [Security](security.md).

| Endpoint                    | Body                                          | Answer                    |
| --------------------------- | --------------------------------------------- | ------------------------- |
| `GET /apps`                 |                                               | `{ "apps": [...] }`       |
| `GET /apps/<name>`          |                                               | one app                   |
| `PUT /apps/<name>`          | `{ "mapUrl": "...", "segments": ["plan"] }`   | the app                   |
| `PUT /apps/<name>`          | `{ "map": "/\n/invoices\n", "segments": [] }` | the app                   |
| `POST /apps/<name>/refresh` |                                               | the app                   |
| `DELETE /apps/<name>`       |                                               | `{ "removed": "<name>" }` |

An app in an answer has these fields: `name`, `mapUrl` (null for an uploaded map), `pages` (the
number of lines of the map), `segments`, `createdAt`, `mapUpdatedAt`, `mapError`, `accepted`,
`rejected` and `rejections` (the rejected records by reason, for up to 50 reasons).
