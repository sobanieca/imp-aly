# The records of bots and prerendered pages are rejected

## Context

An imp app sends its records from JavaScript. A simple crawler does not run JavaScript, so it sends
no records. But Googlebot, Bingbot, the crawlers of AI companies and Lighthouse render the page in a
browser. These browsers run the app and send records like a person. Such records make the counts of
visits and pages too high.

A browser can also prefetch or prerender a page before a person opens it. The person can open the
page or not. A record of a prerendered page that nobody opens is not a visit.

No header proves that a request comes from a person. A bot can send any header. But most crawlers
name themselves in the `User-Agent` header, and a prerender sends the `Sec-Purpose` header.

## Decision

**The collect endpoint rejects all records of a request whose headers show a bot or a prerender. It
counts them under the reasons `the user agent is a bot` and `the browser prerendered the page`.**

- A `User-Agent` header that holds `bot`, `crawl`, `spider`, `slurp`, `headless`, `lighthouse`,
  `pagespeed` or the name of a known preview fetcher shows a bot. The match ignores the case.
  `cubot` is the name of a phone, so it does not match.
- A `Sec-Purpose` or `Purpose` header that holds `prefetch` or `prerender` shows a prerender.
- A request without a `User-Agent` header passes. `curl` and HTTP libraries pass, so a person can
  test the endpoint by hand.
- The server answers `202` with the counts, as for other rejected records. The rate limit counts the
  request.
- The server reads the `User-Agent` header for the check only. It does not store it.
- The list is fixed in the binary. There is no option to change it.
- `alySink` of imp sends nothing when `navigator.webdriver` is `true`, and it holds the records of a
  prerendered page until the page shows. So a sink of imp does not reach this check in normal use.

## Consequences

- The visits of honest crawlers, link previews and page speed tests do not count.
- `imp-aly app show` prints how many records of bots the server rejected.
- A bot that copies the headers of a browser still passes. The check filters noise. It is not a
  defense against forged records.
- A new crawler with a name outside the list passes until the list gets its name.
