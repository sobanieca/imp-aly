# A sealed day carries a summary, and queries read it when they can

## Context

An app with 10,000 people a day stores about 1,100,000 records a day. A scan reads about 1,000,000
records in 2 seconds, so a report of 180 days takes about 8 minutes. The report of imp asks for
counts grouped by few fields: `type`, `page`, `zone`, `name`, the country and the segments. Those
groups are few, and a sealed day never changes. So the counts of a day can be computed once.

The count of visits is the hard part. Distinct counts do not add up across groups: one visit can see
two pages. Counting distinct visit ids across a whole range needs a set of every pair of visit and
group, which costs more than the scan it replaces.

## Decision

**When the storage worker seals a day, it writes a daily summary into the sealed folder. A query
reads the summary of a sealed day when the query allows it, and scans the columns otherwise.
`visits` is the number of distinct visits of each day, added up over the days.**

- `summary-counts.tsv` has one line per combination of `type`, `page`, `zone`, `name`, `country` and
  the segments. A line has the number of records, the sum, the minimum and the maximum of `readyMs`,
  and the `readyMs` buckets as `bucket:count` pairs, see `ready-time-buckets.md`. A scan puts the
  values into the same buckets, so both paths give the same percentiles.
- `summary-tuples.tsv` lists each combination of `type`, `page`, `country` and the segments that
  occurs. `summary-visits.tsv` has one line per set of tuples that a visit had, with the number of
  visits that had that set. A query maps each tuple to its group, and adds the count of a line once
  to each group that the line reaches. So the visits of a day are exact without a set.
- A query uses the summaries when it does not name `visit`, and when it does not count `visits` with
  `zone` or `name`. The tuples leave out `zone` and `name` to keep the visit file small.
- A day uses its summary only when it has no raw records above the sealed generation. A day with
  late records is scanned until the next seal.
- The scan path counts `visits` per day too, so both paths give the same result. A test checks this
  for many queries.
- `meta.json` has `summary: true`. The summary files are part of the sealed folder, so the rename of
  the folder makes them visible together with the columns.
- A backup holds the summaries, and a restored day holds only its summary, see `summary-backups.md`.
  The retention keeps the summary of an old day when it removes the records, see
  `disk-space-retention.md`.

## Consequences

- A query of 180 sealed days of 1,100,000 records each takes 4 to 7 seconds, and about 150 MB.
- A visit that lasts past midnight UTC counts once on each of its days. This is the rule of many
  analytics tools, and the docs state it.
- A seal takes longer, about 15 seconds for 1,000,000 records. A summary takes about 2 MB a day.
- The current day is not sealed, so every query scans it.
