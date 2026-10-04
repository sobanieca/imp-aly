# Fast trends over long ranges

The console shows the visits of an app over up to 5 years. Such a query reads the daily summary of
each day: about 1,800 summaries. For an app with 1,000,000 records a day, a summary takes about 40
ms to read, so the query takes about 70 seconds. The server runs one query at a time, so the trends
of several apps wait for each other, and a query stops after 120 seconds.

Write a small file of totals for each app when a day is sealed: one line per day with the visits and
the page views of the day. A query that asks only for `visits` or `records` of all the records,
grouped by a time, reads this file and no summary. Keep the file in the backup, and check it in a
restore, as the summaries.

Measure the time of a 5-year query on the demo data and on a large generated app first. Do this item
only when the time is a real problem.
