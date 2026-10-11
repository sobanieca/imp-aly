const BOT_WORDS: [&str; 13] = [
    "crawl",
    "spider",
    "slurp",
    "headless",
    "lighthouse",
    "pagespeed",
    "phantomjs",
    "facebookexternalhit",
    "bingpreview",
    "ia_archiver",
    "mediapartners-google",
    "feedfetcher",
    "google-inspectiontool",
];

fn names_a_bot(agent: &str) -> bool {
    let lower = agent.to_ascii_lowercase();
    if BOT_WORDS.iter().any(|word| lower.contains(word)) {
        return true;
    }
    lower
        .match_indices("bot")
        .any(|(at, _)| at < 2 || &lower[at - 2..at] != "cu")
}

pub fn bot_problem(
    sec_purpose: Option<&str>,
    purpose: Option<&str>,
    user_agent: Option<&str>,
) -> Option<&'static str> {
    let purpose = sec_purpose.or(purpose).unwrap_or("").to_ascii_lowercase();
    if purpose.contains("prefetch") || purpose.contains("prerender") {
        return Some("the browser prerendered the page");
    }
    if names_a_bot(user_agent.unwrap_or("")) {
        return Some("the user agent is a bot");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const BROWSER: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

    #[test]
    fn a_browser_passes() {
        assert_eq!(bot_problem(None, None, Some(BROWSER)), None);
        assert_eq!(bot_problem(None, None, None), None);
        assert_eq!(
            bot_problem(
                None,
                None,
                Some("Mozilla/5.0 (Linux; Android 14; Cubot P80)")
            ),
            None
        );
    }

    #[test]
    fn a_user_agent_that_names_a_bot_fails() {
        for agent in [
            "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Mozilla/5.0 (compatible; bingbot/2.0)",
            "Mozilla/5.0 HeadlessChrome/129.0",
            "facebookexternalhit/1.1",
            "Mozilla/5.0 (compatible; YandexSpider)",
            "Chrome-Lighthouse",
        ] {
            assert_eq!(
                bot_problem(None, None, Some(agent)),
                Some("the user agent is a bot"),
                "{agent}"
            );
        }
    }

    #[test]
    fn a_prefetch_or_a_prerender_fails() {
        assert_eq!(
            bot_problem(Some("prefetch;prerender"), None, Some(BROWSER)),
            Some("the browser prerendered the page")
        );
        assert_eq!(
            bot_problem(None, Some("prefetch"), Some(BROWSER)),
            Some("the browser prerendered the page")
        );
    }
}
