# A scan reads the columns in blocks and works on ids of the values

## Context

A scan read each column of a day into a list of texts, one text per row. A day of 10,000,000
records took about 1.8 GB of memory and 14 seconds. A filter and a group key made a text per row.
The values of a column repeat many times in a day, and a sealed `.rle` file stores a run of equal
values in one line.

## Decision

**A scan reads each column file of a day in blocks of 65,536 rows. Each distinct value of a column
of a day gets a `u32` id. A block of a column is a list of runs: an id and a count of rows. Filters
and groups work on the ids.**

- A plain column file gives one run per line, and equal lines next to each other join one run. A
  line of an `.rle` file stays one run, also when it is longer than a block. A column that a part
  does not have is one run of null.
- A filter decides once per id of its column, and then marks or clears the rows of a whole run. So a
  sealed day matches its filters on the runs, not on the rows.
- A group key is the list of the ids of the group fields. Up to two ids pack into one `u64`. The
  scan makes the texts of a group only once, at the end of the day.
- `visits` keeps the pairs of a group and a visit id in a list. The scan sorts the list and removes
  the doubles when it grows past 4,194,304 pairs, and at the end of the day. So the count is exact,
  and the memory grows with the distinct pairs, not with the rows.
- The reader of a line does not make a text. It finds the line breaks eight bytes at a time, and
  passes each line as bytes to the dictionary of the column. A value of up to 7 bytes is a `u64`
  key, a longer value is a byte key.
- The scan checks the stop flag once per block. It keeps the checks of the row counts: a file with
  fewer or more rows than its commit or its meta fails the source of the day.

## Consequences

- A scan of 1,000,000 records takes about 0.2 seconds. A scan of 10,000,000 records takes about 3
  seconds and about 100 MB of memory.
- The memory of a scan grows with the distinct values of its columns and the distinct pairs of a
  group and a visit, and not with the rows.
