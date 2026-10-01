# An append to the columns is a transaction that reverts

## Context

The column files of a folder must keep the same number of lines, see `plain-text-column-files.md`. A
crash between two appends leaves one file a line longer than the others, and every later record then
gets wrong values. Immutable batch folders avoid this, but they create thousands of small folders a
day and need a merge step.

## Decision

**The storage worker appends to the column files of a folder in a transaction that a commit file
closes, and that it reverts on any error.**

- `commit.json` holds the number of rows, the committed size in bytes of each file, and the id of
  the last log part in the folder.
- An append: read the commit, cut each file to its committed size, append the new lines to each
  file, sync each file, then write the new commit to a temporary file, sync it, and rename it over
  `commit.json`. The rename is the commit.
- On an error, the worker cuts each file back to its committed size and removes the files that the
  transaction created. Then it throws, and the loop tries the part again later.
- A crash leaves at most a tail after the committed size. The next append cuts it.
- A reader reads `commit.json` first, then each file only up to its committed size. So a reader
  never sees an append in progress, and needs no lock.
- A folder skips a log part whose id is not above its commit, or above the commit of its sealed
  data. So a part that the worker reads twice is stored once.

## Consequences

- The alignment of the columns holds through a crash at any point.
- Each part costs one sync per file of each day that it touches. The worker groups the records of a
  part by app and day, so a part of 2 seconds is about ten syncs.
