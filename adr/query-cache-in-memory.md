# The query thread keeps sealed summaries in memory

## Context

A report of the console sends the same few queries again and again, for example the Overview of the
last 180 days. A sealed day, week or month never changes. Without a cache, each query lists the
folders of each day, reads `meta.json`, reads the summary files and parses them again. On a VPS disk,
one folder list or one file read costs about 50 microseconds, so the reads cost more than the counts.

## Decision

**The query engine keeps, per folder, the folder list, the sealed meta, the parsed summary and the
counts of each query shape, in memory, up to 256 MB. It checks each kept folder with one `stat`
before it uses it.**

- A parsed summary keeps each cell as a `u32` id in one dictionary of values per summary. A query
  matches its filters on the ids and builds its group keys from the ids.
- The key of a kept folder is its path. The entry holds the device, the inode, the modification time
  and the change time of the folder. A new generation, a new or removed folder or file in the folder,
  or a new folder at the same path changes these values, and the entry goes.
- The server keeps a folder only when its modification and change times are 2 seconds old or more.
  So two changes in the same tick of the file system clock cannot hide a change.
- The entry of a sealed folder also holds the counts per group that each query shape gave. A shape is
  the day, the filters, the groups and the measures. The answer of a query is the sum of these counts,
  as before. Up to 32 shapes stay per folder.
- When the cache is full, the entry that a query used last the longest time ago goes.
- The query thread holds the engine. A restart of the server starts with an empty cache.

## Consequences

- A second run of a query of 180 sealed days costs about two `stat` calls per day.
- The server can use up to 256 MB of memory more than before.
- A change of a sealed folder by hand is seen at the next query, as long as it changes the folder.
  A change inside a file that keeps the folder as it is, is not seen.
