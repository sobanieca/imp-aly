use crate::api_client::{CALL_TIMEOUT_MS, call_server, resolve_one};
use crate::args::{Parsed, parse_timeout, require_only_flags};
use crate::error::{Error, Result};
use crate::json;
use crate::servers::Selection;

pub fn selection(parsed: &Parsed) -> Selection<'_> {
    Selection {
        url: parsed.get("url"),
        auth: parsed.get("auth"),
        server: parsed.get("server"),
    }
}

pub fn status(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["auth", "url", "server", "timeout"], "status")?;
    if parsed.positional.len() > 1 {
        return Err(Error::new(
            "use: imp-aly status [-s <server> | --url <url>]",
        ));
    }
    let target = resolve_one(&selection(parsed))?;
    let timeout = parse_timeout(parsed.get("timeout"))?.unwrap_or(CALL_TIMEOUT_MS);
    let result = call_server(&target, "GET", "/status", None, Some(timeout))?;
    println!("{}", json::pretty(&result));
    Ok(())
}
