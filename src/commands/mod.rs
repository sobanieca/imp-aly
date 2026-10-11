pub mod app;
pub mod backup;
pub mod console;
pub mod help;
pub mod key;
pub mod query;
pub mod restore;
pub mod server;
pub mod servers;
pub mod skill;
pub mod status;
pub mod token;
pub mod update;

use crate::args::{Parsed, parse_args};
use crate::error::{Error, Result};
use crate::logger;

pub fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(64)
        .thread_name("imp-aly")
        .build()
        .map_err(|error| Error::new(format!("cannot start the runtime: {error}")))
}

fn dispatch(parsed: &Parsed) -> Result<()> {
    if parsed.has("version") {
        println!("{}", crate::VERSION);
        return Ok(());
    }
    let Some(name) = parsed.positional.first() else {
        help::help();
        return Ok(());
    };
    if parsed.has("help") {
        help::help();
        return Ok(());
    }
    match name.as_str() {
        "add" => servers::add(parsed),
        "app" => app::app(parsed),
        "backup" => backup::backup(parsed),
        "console" => console::console(parsed),
        "group" => servers::group(parsed),
        "help" => {
            help::help();
            Ok(())
        }
        "key" => key::key(parsed),
        "ls" => servers::ls(parsed),
        "query" => query::query(parsed),
        "restore" => restore::restore(parsed),
        "rm" => servers::rm(parsed),
        "server" => server::server(parsed),
        "skill" => skill::skill(parsed),
        "status" => status::status(parsed),
        "token" => token::token(parsed),
        "update" => update::update(parsed),
        "use" => servers::use_saved(parsed),
        "version" => {
            println!("{}", crate::VERSION);
            Ok(())
        }
        other => Err(Error::new(format!(
            "unknown command \"{other}\" - run imp-aly help"
        ))),
    }
}

pub fn main(argv: &[String]) -> i32 {
    let outcome = parse_args(argv).and_then(|parsed| {
        logger::set_debug(parsed.has("debug"));
        dispatch(&parsed)
    });
    match outcome {
        Ok(()) => 0,
        Err(error) => {
            logger::error(&error.message);
            1
        }
    }
}
