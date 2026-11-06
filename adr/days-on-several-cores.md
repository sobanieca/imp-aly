# The days of a query are read on several cores

## Context

A query reads each day, week and month of its range on its own, and then adds up their counts. The
reads do not depend on each other. A scan of 180 days on one core takes more than a second, and a
VPS often has 2 to 8 cores.

## Decision

**The query thread reads the folders, days, weeks and months of one query on up to one thread per
core, with `std::thread::scope`. It adds the counts of each part in the order of the parts, as on
one thread.**

- The threads take the parts in their order from one counter. Each thread sends the counts of a
  part to the query thread. The query thread keeps the parts that arrive early, and adds them in
  order. So the answer, also the order of its groups, is the same on any number of cores.
- The merge only adds counts. A part never sends a finished measure.
- The query thread first reads the parts alone. It starts the other threads only when the parts that
  are left take more than 5 milliseconds by its measure. A cached query does not pay for threads.
  Its parts are too small to share, because the threads wait for each other on the cache.
- The query plans all its parts before it reads them: the months, then the weeks that no planned
  month touches, then the days that no planned month or week covers. The threads read these parts
  in one step, so they do not wait for the months before they start the weeks.
- A day that an unplanned week covers counts only when that week cannot be used, because a month
  that touches the week was used. When a month or a week cannot be read, the next step plans the
  weeks and the days of its range. So the query uses the same parts as a read of the months, then
  the weeks, then the days.
- An error that stops the query, for example the group limit, also stops the threads. The stop flag
  and the limit of 120 seconds stay. Each thread checks the flag before each part, and a scan checks
  it in each block.
- A panic in a thread fails only the query, as before.

## Consequences

- A scan of 180 sealed days on 4 cores takes about a third of the time on 1 core.
- The first Overview of 180 sealed days on 4 cores takes about 40 percent of the time on 1 core.
  It has few parts, and each part is a large summary to parse. A part takes about a quarter longer
  when 4 threads parse at the same time.
- A query uses all the cores for its time. Records still go to the log on their own thread, so the
  collection of records does not wait.
