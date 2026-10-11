use std::fmt;
use std::io;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub message: String,
    pub status: Option<u16>,
    pub not_found: bool,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
            status: None,
            not_found: false,
        }
    }

    pub fn status(status: u16, message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
            status: Some(status),
            not_found: false,
        }
    }

    pub fn io(error: &io::Error, path: impl AsRef<str>) -> Self {
        Error {
            message: format!("{error}: {}", path.as_ref()),
            status: None,
            not_found: error.kind() == io::ErrorKind::NotFound,
        }
    }

    pub fn missing(message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
            status: None,
            not_found: true,
        }
    }

    pub fn context(self, prefix: impl fmt::Display) -> Self {
        Error {
            message: format!("{prefix}{}", self.message),
            ..self
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Error {
            message: error.to_string(),
            status: None,
            not_found: error.kind() == io::ErrorKind::NotFound,
        }
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Error::new(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Error::new(message)
    }
}

#[macro_export]
macro_rules! fail {
    ($($arg:tt)*) => {
        return Err($crate::error::Error::new(format!($($arg)*)))
    };
}
