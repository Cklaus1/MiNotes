//! Legacy notebooks: databases stored as `<base>/<name>.db` (normally
//! `~/.minotes/<name>.db`, keyed by `<name>`). The file layout is unchanged from
//! when these were called "graphs"; see `crate::notebook` for both kinds.

use std::fs;
use std::path::Path;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::LegacyNotebookInfo;

/// List all legacy notebook databases (`.db` files) in the given base directory.
pub fn list(base_dir: &Path) -> Result<Vec<LegacyNotebookInfo>> {
    let mut found = Vec::new();

    let entries = fs::read_dir(base_dir).map_err(|e| {
        Error::InvalidInput(format!("Cannot read directory {}: {}", base_dir.display(), e))
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| Error::InvalidInput(e.to_string()))?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) == Some("db") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                let meta = fs::metadata(&path)
                    .map_err(|e| Error::InvalidInput(e.to_string()))?;

                let modified_at = meta
                    .modified()
                    .ok()
                    .and_then(|t| {
                        let dt: chrono::DateTime<chrono::Utc> = t.into();
                        Some(dt.to_rfc3339())
                    })
                    .unwrap_or_default();

                found.push(LegacyNotebookInfo {
                    name: stem.to_string(),
                    path: path.to_string_lossy().to_string(),
                    size_bytes: meta.len(),
                    modified_at,
                });
            }
        }
    }

    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

/// Create a new legacy notebook database with the given name.
/// Returns the LegacyNotebookInfo for the newly created database.
pub fn create(base_dir: &Path, name: &str) -> Result<LegacyNotebookInfo> {
    // Validate name: no path separators, no dots (except the .db we add)
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains('.')
        || name.contains('\0')
    {
        return Err(Error::InvalidInput(format!(
            "Invalid notebook name: '{name}'. Must be non-empty and contain no path separators or dots."
        )));
    }

    let db_path = base_dir.join(format!("{name}.db"));

    if db_path.exists() {
        return Err(Error::AlreadyExists(format!("A notebook named '{name}' already exists")));
    }

    // Create the database (this initializes the schema)
    let _db = Database::open(&db_path)?;

    let meta = fs::metadata(&db_path)
        .map_err(|e| Error::InvalidInput(e.to_string()))?;

    let modified_at = meta
        .modified()
        .ok()
        .and_then(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            Some(dt.to_rfc3339())
        })
        .unwrap_or_default();

    Ok(LegacyNotebookInfo {
        name: name.to_string(),
        path: db_path.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        modified_at,
    })
}

/// Delete a legacy notebook database file.
/// Returns true if the file was deleted, false if it didn't exist.
pub fn delete(base_dir: &Path, name: &str) -> Result<bool> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(Error::InvalidInput(format!("Invalid notebook name: '{name}'")));
    }

    let db_path = base_dir.join(format!("{name}.db"));

    if !db_path.exists() {
        return Ok(false);
    }

    // Also remove WAL and SHM files if they exist
    let wal_path = base_dir.join(format!("{name}.db-wal"));
    let shm_path = base_dir.join(format!("{name}.db-shm"));
    let _ = fs::remove_file(&wal_path);
    let _ = fs::remove_file(&shm_path);

    fs::remove_file(&db_path)
        .map_err(|e| Error::InvalidInput(format!("Failed to delete notebook '{name}': {e}")))?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_create_and_list() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path();

        // Initially empty
        let found = list(base).unwrap();
        assert!(found.is_empty());

        // Create one
        let info = create(base, "work").unwrap();
        assert_eq!(info.name, "work");
        assert!(info.size_bytes > 0);

        // List should have one
        let found = list(base).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "work");
    }

    #[test]
    fn test_create_duplicate() {
        let tmp = TempDir::new().unwrap();
        create(tmp.path(), "test").unwrap();
        let err = create(tmp.path(), "test");
        assert!(err.is_err());
    }

    #[test]
    fn test_delete() {
        let tmp = TempDir::new().unwrap();
        create(tmp.path(), "temp").unwrap();
        assert!(delete(tmp.path(), "temp").unwrap());
        assert!(!delete(tmp.path(), "temp").unwrap());
    }

    #[test]
    fn test_invalid_names() {
        let tmp = TempDir::new().unwrap();
        assert!(create(tmp.path(), "").is_err());
        assert!(create(tmp.path(), "foo/bar").is_err());
        assert!(create(tmp.path(), "foo.bar").is_err());
    }
}
