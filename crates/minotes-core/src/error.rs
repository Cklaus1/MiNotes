use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    AlreadyExists(String),
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Git error: {0}")]
    Git(String),
    /// An encrypted notebook's passphrase or recovery key did not unwrap its key.
    #[error("Wrong passphrase")]
    WrongPassphrase,
    /// The key unwrapped fine but does not open the database (damaged or replaced).
    #[error("The notebook's database does not match its key (damaged or replaced)")]
    KeyMismatch,
    /// An encrypted notebook that has not been unlocked.
    #[error("Notebook '{0}' is locked")]
    Locked(String),
}

pub type Result<T> = std::result::Result<T, Error>;
