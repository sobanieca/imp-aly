# Ready times are counted in buckets of 2 significant digits

## Context

The speed of a page is the distribution of `readyMs` over its page views. A percentile of all the
page views needs every value, or a histogram that adds up. When several servers hold the records,
each server must send something that the client can add up. A list of each distinct value with its
count grows with the number of distinct values, up to thousands per group.

## Decision

**A query and a daily summary count `readyMs` in buckets. A bucket is the value with all digits
after the first two set to zero. Values below 100 are their own bucket. The sum, the minimum and the
maximum stay exact.**

- 423 is in the bucket 420, which holds 420 to 429. 1234 is in the bucket 1200, which holds 1200 to
  1299. The range of 0 to 3600000 ms has at most about 510 buckets.
- `pN` is the middle of the bucket that holds the rank `ceil(N% of the count)`. The middle is at
  most 5% from any value of the bucket.
- `readyMs.under:<ms>` is the percent of the values below `<ms>`. `<ms>` must be a bucket edge, such
  as `1000` or `2500`, so the percent is exact. It is the main measure of speed in a report, like
  the "good" share of the Core Web Vitals.
- `avg` is the exact sum divided by the count. `min` and `max` are exact.
- The column files keep the exact `readyMs` of each record. A scan puts the values into the same
  buckets as the summary, so both paths give the same result.
- The client adds the bucket counts of all servers, then reads the percentile. It never averages the
  percentiles of the servers.

## Consequences

- A percentile can differ from the exact value by up to 5%. For a page speed, this difference does
  not change a decision.
- The answer of a group with a percentile has at most about 510 pairs, and usually 100 to 180. A
  group with few page views has few pairs.
- The size of a summary line has a limit that does not depend on the number of page views.
