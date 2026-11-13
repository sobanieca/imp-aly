# imp-aly - Apps

The server accepts records only for a registered app. An app has a name, the build file, the origins
of its pages and an optional list of segments.

## The build file

When an app has a map, `imp build` writes `app-analytics.json` at the root of the build output. It
is one JSON object with three lists:

```json
{
  "pages": ["/", "/invoices", "/invoices/:id"],
  "zones": ["myapp.invoice-list", "myapp.send"],
  "outcomes": ["myapp.invoice-sent"]
}
```

| List       | Content                                                           |
| ---------- | ----------------------------------------------------------------- |
| `pages`    | the route patterns, such as `/invoices/:id`                       |
| `zones`    | the zone names: each name that the code gives to `zone({ name })` |
| `outcomes` | the outcome names: each name that the code gives to `track(name)` |

The server stores a record only when its `page` is in `pages`, its zone is in `zones` and its
outcome name is in `outcomes`. A `used` record with a null zone needs no zone in the file. So a
forged record cannot add a page, a zone or an outcome name that the app does not have.

- `pages` has at least one route pattern. A pattern starts with `/`.
- `zones` and `outcomes` can be empty, for an app with no zone or no outcome.
- A zone name and an outcome name are namespaced names, such as `myapp.send`. See
  [Collecting records](collect.md#the-checks).
- An entry that occurs more than one time in a list counts once.
- The file is at most 3 MiB, with at most 10,000 entries in each list.

## Register an app

```sh
imp-aly app add myapp https://myapp.example/
imp-aly app add myapp https://myapp.example/ --segments plan,role
```

- **The name** is 1 to 63 lowercase letters, digits and `-`, and starts with a letter or a digit.
  The app sends its records to `/collect/<name>`.
- **The URL** is the address of the folder where the build output is served, such as
  `https://myapp.example/` or `https://myapp.example/app/`. The server reads `app-analytics.json` in
  that folder at once, and again every 10 minutes. When a read fails, the server keeps the last
  lists and shows the error in `app ls`.
  - The server must be able to read the file. Serve it on a public URL, or on a URL that the VPS
    can reach.
  - A folder on your machine, such as `dist`, is not a URL. The command fails with it.
- **The origins** are the browser origins of the pages of the app, such as `https://myapp.example`.
  The app accepts records only from these pages. See
  [Collecting records](collect.md#cors-and-allowed-origins).
  - With no `--origins`, the origin is the origin of the URL.
  - `--origins` takes a list with commas, such as
    `--origins https://myapp.example,http://localhost:5173`. An app has at most 32 origins.
- **The segments** are the extra fields that your sink adds to each record, such as `plan`. See
  [Segments](#segments).

One server holds many apps. Register each app with its own name and its own origins. Each app sends
its records to its own `/collect/<name>`, and accepts only the pages of its own origins.

`app add` replaces an app of the same name, also its origins. The counts of accepted and rejected
records stay.

With several servers, give all of them to each `app` command, so that each server has the same build
file and the same segments:

```sh
imp-aly app add myapp https://myapp.example/ -s eu-1,eu-2,eu-3
imp-aly app refresh myapp -s eu-1,eu-2,eu-3
imp-aly app ls -s eu-1,eu-2,eu-3
```

See [Several servers](query.md#several-servers).

When the file cannot be read, or an entry of a list is not valid, the command fails and the server
keeps the previous state. The error names the list and the index of the entry, such as `zones[3]`.

## Update the build file after a deploy

A new screen, a new zone or a new outcome in your app is a new entry in the build file. Until the
server knows the new entry, it rejects the records of it. So update the file in the same pipeline
that deploys the app:

```sh
imp-aly app refresh myapp
```

`refresh` reads `app-analytics.json` at the URL again.

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
See [Segments](https://imp-ui.com/docs/analytics#segments) in the imp
docs.

Declare each segment when you register the app. The server rejects a record that has a field that
the app does not declare. This keeps a typo or a forged field out of the data.

- A segment name is 1 to 32 letters and digits, and starts with a letter.
- These names are reserved, in any case: `type`, `visit`, `at`, `page`, `zone`, `name`, `country`,
  `day`, `week`, `month`, `records` and `visits`. The names of the built-in properties of a
  JavaScript object, such as `constructor`, `toString` and `valueOf`, are reserved too.
- Two segment names of one app must differ in more than the case, such as `plan` and `Plan`. Some
  file systems do not tell them apart.
- An app has at most 16 segments.
- A segment value is null, a number, a boolean, or a text of 1 to 64 ASCII letters, digits, `.`, `-`
  or `_`. Use values such as `pro`, `en-US` or `1.2.3`. See [Collecting records](collect.md).

**Do not put personal data in a segment.** A user id, an email address or an organization id is
personal data, also when you hash it. Add groups, not ids.

## The API

The commands call these endpoints. Each one needs a token, see [Security](security.md).

| Endpoint                    | Body                                            | Answer                    |
| --------------------------- | ----------------------------------------------- | ------------------------- |
| `GET /apps`                 |                                                 | `{ "apps": [...] }`       |
| `GET /apps/<name>`          |                                                 | one app                   |
| `PUT /apps/<name>`          | `{ "appUrl": "...", "segments": ["plan"] }`     | the app                   |
| `POST /apps/<name>/refresh` |                                                 | the app                   |
| `DELETE /apps/<name>`       |                                                 | `{ "removed": "<name>" }` |

`appUrl` is required. `origins` is a list of origins, such as `["https://myapp.example"]`. When you
omit it, the list is the origin of `appUrl`.

An app in an answer has these fields:

- `name`
- `appUrl`: the URL of the folder of the build, with a `/` at the end
- `pages`, `zones` and `outcomes`: the lists of the build file, sorted
- `segments`
- `origins`: the browser origins that can send records, sorted
- `createdAt`
- `buildUpdatedAt`: the time of the last successful read of the file
- `buildError`: the error of the last read, or null
- `accepted` and `rejected`: the counts of records
- `rejections`: the rejected records by reason, for up to 50 reasons
