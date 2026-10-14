use super::runtime;
use crate::args::{Parsed, parse_port, require_only_flags};
use crate::console::{DEFAULT_CONSOLE_PORT, start_console};
use crate::error::{Error, Result};
use crate::logger;
use crate::static_files::Files;

pub fn console(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["port"], "console")?;
    if parsed.positional.len() > 1 {
        return Err(Error::new("use: imp-aly console [--port <port>]"));
    }
    let port = parsed
        .get("port")
        .map(parse_port)
        .transpose()?
        .unwrap_or(DEFAULT_CONSOLE_PORT);
    let runtime = runtime()?;
    runtime.block_on(async {
        let running = start_console(port, Files::Embedded).await?;
        logger::plain(format!("imp-aly {} - console", crate::VERSION));
        logger::plain("");
        logger::plain(format!("To open the console, go to {}", running.url));
        logger::plain("");
        logger::plain(
            "Add your servers and their keys in the page. Press Ctrl+C to stop the console.",
        );
        super::server::wait_for_stop().await;
        running.shutdown().await;
        Ok(())
    })
}
