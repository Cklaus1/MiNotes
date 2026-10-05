pub mod block;
pub mod events;
pub mod export;
pub mod folder;
pub mod graph;
pub mod journal;
pub mod links;
pub mod page;
pub mod property;
pub mod query;
pub mod search;
pub mod sync;

use uuid::Uuid;

/// Parse an optional UUID argument. An unparseable value is an error (printed,
/// exit code 1) rather than being silently treated as "not given" — that used
/// to turn e.g. `--parent typo` into a root-level operation that exited 0.
pub fn parse_opt_uuid(value: Option<&str>, what: &str) -> Result<Option<Uuid>, i32> {
    match value {
        None => Ok(None),
        Some(s) => Uuid::parse_str(s).map(Some).map_err(|_| {
            crate::output::print_error(&format!("Invalid {what} UUID: {s}"));
            1
        }),
    }
}
