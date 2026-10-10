const BOT_AGENT =
  /(?<!cu)bot|crawl|spider|slurp|headless|lighthouse|pagespeed|phantomjs|facebookexternalhit|bingpreview|ia_archiver|mediapartners-google|feedfetcher|google-inspectiontool/i

const PRERENDER = /prefetch|prerender/i

export const botProblem = (headers) => {
  if (PRERENDER.test(headers.get('sec-purpose') ?? headers.get('purpose') ?? '')) {
    return 'the browser prerendered the page'
  }
  if (BOT_AGENT.test(headers.get('user-agent') ?? '')) return 'the user agent is a bot'
  return null
}
