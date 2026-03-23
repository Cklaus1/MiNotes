use std::fs;
use std::path::Path;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::GraphInfo;

/// List all graph databases (`.db` files) in the given base directory.
pub fn list_graphs(base_dir: &Path) -> Result<Vec<GraphInfo>> {
    let mut graphs = Vec::new();

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

                graphs.push(GraphInfo {
                    name: stem.to_string(),
                    path: path.to_string_lossy().to_string(),
                    size_bytes: meta.len(),
                    modified_at,
                });
            }
        }
    }

    graphs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(graphs)
}

/// Create a new graph database with the given name.
/// Returns the GraphInfo for the newly created database.
pub fn create_graph(base_dir: &Path, name: &str) -> Result<GraphInfo> {
    // Validate name: no path separators, no dots (except the .db we add)
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains('.')
        || name.contains('\0')
    {
        return Err(Error::InvalidInput(format!(
            "Invalid graph name: '{name}'. Must be non-empty and contain no path separators or dots."
        )));
    }

    let db_path = base_dir.join(format!("{name}.db"));

    if db_path.exists() {
        return Err(Error::AlreadyExists(format!("Graph '{name}'")));
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

    Ok(GraphInfo {
        name: name.to_string(),
        path: db_path.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        modified_at,
    })
}

/// Delete a graph database file.
/// Returns true if the file was deleted, false if it didn't exist.
pub fn delete_graph(base_dir: &Path, name: &str) -> Result<bool> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(Error::InvalidInput(format!("Invalid graph name: '{name}'")));
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
        .map_err(|e| Error::InvalidInput(format!("Failed to delete graph '{name}': {e}")))?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_create_and_list_graphs() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path();

        // Initially empty
        let graphs = list_graphs(base).unwrap();
        assert!(graphs.is_empty());

        // Create a graph
        let info = create_graph(base, "work").unwrap();
        assert_eq!(info.name, "work");
        assert!(info.size_bytes > 0);

        // List should have one
        let graphs = list_graphs(base).unwrap();
        assert_eq!(graphs.len(), 1);
        assert_eq!(graphs[0].name, "work");
    }

    #[test]
    fn test_create_duplicate_graph() {
        let tmp = TempDir::new().unwrap();
        create_graph(tmp.path(), "test").unwrap();
        let err = create_graph(tmp.path(), "test");
        assert!(err.is_err());
    }

    #[test]
    fn test_delete_graph() {
        let tmp = TempDir::new().unwrap();
        create_graph(tmp.path(), "temp").unwrap();
        assert!(delete_graph(tmp.path(), "temp").unwrap());
        assert!(!delete_graph(tmp.path(), "temp").unwrap());
    }

    #[test]
    fn test_invalid_graph_names() {
        let tmp = TempDir::new().unwrap();
        assert!(create_graph(tmp.path(), "").is_err());
        assert!(create_graph(tmp.path(), "foo/bar").is_err());
        assert!(create_graph(tmp.path(), "foo.bar").is_err());
    }
}
