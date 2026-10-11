use crate::args::{Parsed, require_only_flags};
use crate::auth::find_key;
use crate::error::{Error, Result};
use crate::servers::{Selection, resolve_target};
use crate::token::{EMPTY_BODY_HASH, Sha256, create_token};
use std::io::Read;

const USAGE: &str = "use: imp-aly token <method> <path> [<body file>] [-s <server>] [-a <key or file>], like: imp-aly token GET /status";

pub fn hash_file(path: &str, what: &str) -> Result<String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| Error::new(format!("cannot read the {what} {path}: {error}")))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|error| Error::new(format!("cannot read the {what} {path}: {error}")))?;
        if size == 0 {
            return Ok(hash.hex());
        }
        hash.update(&buffer[..size]);
    }
}

pub fn token(parsed: &Parsed) -> Result<()> {
    require_only_flags(parsed, &["auth", "server"], "token")?;
    let method = parsed.positional.get(1);
    let path = parsed.positional.get(2);
    let file = parsed.positional.get(3);
    let (Some(method), Some(path)) = (method, path) else {
        return Err(Error::new(USAGE));
    };
    if parsed.positional.len() > 4
        || method.is_empty()
        || !method.bytes().all(|byte| byte.is_ascii_alphabetic())
        || !path.starts_with('/')
    {
        return Err(Error::new(USAGE));
    }
    let body_hash = match file {
        Some(file) => hash_file(file, "body file")?,
        None => EMPTY_BODY_HASH.to_string(),
    };
    let target = resolve_target(&Selection {
        url: None,
        auth: parsed.get("auth"),
        server: parsed.get("server"),
    })?;
    let key = find_key(target.auth.as_deref())?;
    println!("{}", create_token(&key, method, path, &body_hash));
    Ok(())
}
