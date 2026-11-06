# The storage worker keeps a running summary of each open day

## Context

The current day is not sealed, so it has no daily summary. The console asks for the current day in
each report. A scan of 1,000,000 records takes about 1 second, so each report of the current day
waited for a scan, and a report of 180 days waited for the scan of its last day.

## Decision

**The storage worker keeps, in memory, a running summary of each open day of its own source. It adds
each log part that it stores. A query that can use a summary reads the running summary in place of
a scan.**

- An open day is a source folder of a day with raw generations. A sealed day with late records is
  an open day too. Its running summary holds the sealed records and the late records.
- The running summary has the same counts as the daily summary: the records per combination of the
  dimensions and the segments, and the tuples of each visit. A query reads it with the same code as
  a parsed daily summary, so both paths give the same result.
- Each running summary records the state of its folder on the disk: the sealed generation, its
  rows, and the generation, rows and log part of each raw folder. A query reads the state of the
  folder first, and uses the running summary only when the states are equal. Otherwise it scans.
  So the running summary never gives an answer that misses or doubles a record.
- When the worker stores a part, it reads the state before and after the append. It adds the records
  only when the running summary had the state before. A new day starts an empty running summary.
- The worker checks the open days after each pass. When the state of an open day is not the state of
  its running summary, the worker makes the running summary again from the column files. This
  happens after a start, after a restart of the worker, and after an append that the worker did not
  add.
- The worker removes the running summary of a day when the day is sealed or removed.
- The query makes a snapshot of the running summary in the format of a parsed summary when it needs
  one, and keeps it until the next append.
- Only the days of the source of the server have a running summary. Other sources of a day are
  scanned until they are sealed.

## Consequences

- A query of the current day with 1,000,000 records takes a few milliseconds, not a second.
- The memory of the server grows with the distinct combinations and visits of the open days.
- After a start, the worker reads the open days once, about 2 seconds for 1,000,000 records, before
  the running summary serves queries. Until then, queries scan.
- A query that cannot use a summary, for example one that groups by `visit`, still scans the day.
