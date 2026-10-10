import { assertEquals } from './assert.js'
import { botProblem } from '../src/bots.js'

const problemOf = (headers) => botProblem(new Headers(headers))

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

Deno.test('a browser passes', () => {
  assertEquals(problemOf({ 'user-agent': CHROME }), null)
  assertEquals(
    problemOf({
      'user-agent':
        'Mozilla/5.0 (Linux; Android 13; CUBOT KINGKONG 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    }),
    null,
  )
  assertEquals(problemOf({ 'user-agent': 'curl/8.5.0' }), null)
  assertEquals(problemOf({}), null)
})

Deno.test('a user agent that names a bot fails', () => {
  for (
    const agent of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0) Chrome/116.0.1938.76 Safari/537.36',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)',
    ]
  ) {
    assertEquals(problemOf({ 'user-agent': agent }), 'the user agent is a bot', agent)
  }
})

Deno.test('a prefetch or a prerender fails', () => {
  assertEquals(
    problemOf({ 'user-agent': CHROME, 'sec-purpose': 'prefetch;prerender' }),
    'the browser prerendered the page',
  )
  assertEquals(
    problemOf({ 'user-agent': CHROME, purpose: 'prefetch' }),
    'the browser prerendered the page',
  )
})
