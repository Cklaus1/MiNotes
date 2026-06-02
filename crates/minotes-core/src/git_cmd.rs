//! System git wrapper — calls the `git` binary via `std::process::Command`.
//! No libgit2, no native deps. Inherits the user's SSH keys, credential helpers, and .gitconfig.

use std::path::Path;
use std::process::Command;

use crate::error::{Error, Result};

/// Check if git is installed on the system.
pub fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run `git init` in the given directory (creates dir + parents if needed).
pub fn init_repo(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| Error::Git(format!("Cannot create {}: {e}", dir.display())))?;
    let (_, stderr, ok) = run_git(dir, &["init"])?;
    if !ok {
        return Err(Error::Git(format!("git init failed: {stderr}")));
    }
    Ok(())
}

/// Check if the directory is a git repository.
pub fn is_git_repo(dir: &Path) -> bool {
    dir.join(".git").is_dir()
}

/// Check if a remote named "origin" is configured.
pub fn has_remote(dir: &Path) -> bool {
    run_git(dir, &["remote", "get-url", "origin"])
        .map(|(_, _, ok)| ok)
        .unwrap_or(false)
}

/// Get the remote URL for "origin" (None if no remote configured).
pub fn get_remote_url(dir: &Path) -> Result<Option<String>> {
    let (stdout, _, ok) = run_git(dir, &["remote", "get-url", "origin"])?;
    if ok {
        Ok(Some(stdout.trim().to_string()))
    } else {
        Ok(None)
    }
}

/// Get the current branch name.
pub fn get_branch(dir: &Path) -> Result<Option<String>> {
    let (stdout, _, ok) = run_git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if ok {
        let branch = stdout.trim().to_string();
        if branch.is_empty() || branch == "HEAD" {
            Ok(None)
        } else {
            Ok(Some(branch))
        }
    } else {
        Ok(None)
    }
}

/// Stage all changes and commit with the given message.
/// Returns Ok(true) if a commit was made, Ok(false) if nothing to commit.
pub fn commit_all(dir: &Path, message: &str) -> Result<bool> {
    // Stage everything
    let (_, stderr, ok) = run_git(dir, &["add", "-A"])?;
    if !ok {
        return Err(Error::Git(format!("git add failed: {stderr}")));
    }

    // Check if there's anything to commit. `git diff --cached --quiet` exits 0 when
    // the index is CLEAN (no staged changes) and 1 when there ARE staged changes.
    let (_, _, clean) = run_git(dir, &["diff", "--cached", "--quiet"])?;
    if clean {
        return Ok(false); // nothing staged → nothing to commit
    }

    // Commit
    let (stdout, stderr, ok) = run_git(dir, &["commit", "-m", message])?;
    if !ok {
        // "nothing to commit" is not an error (can appear in stdout or stderr)
        if stderr.contains("nothing to commit") || stdout.contains("nothing to commit") {
            return Ok(false);
        }
        return Err(Error::Git(format!("git commit failed: {stderr}")));
    }
    Ok(true)
}

/// Pull with rebase from the remote.
/// Returns Ok(true) on success, Err if conflicts arise.
pub fn pull_rebase(dir: &Path) -> Result<bool> {
    let branch = get_branch(dir)?.unwrap_or_else(|| "main".to_string());
    let (_, stderr, ok) = run_git(dir, &["pull", "--rebase", "origin", &branch])?;
    if !ok {
        if stderr.contains("CONFLICT") || stderr.contains("could not apply") {
            return Err(Error::Git("merge_conflict".to_string()));
        }
        // Network errors, auth errors, etc.
        return Err(Error::Git(classify_git_error(&stderr)));
    }
    Ok(true)
}

/// Push to the remote. Returns Ok(true) on success.
pub fn push(dir: &Path) -> Result<bool> {
    // Get the current branch
    let branch = get_branch(dir)?.unwrap_or_else(|| "main".to_string());
    let (_, stderr, ok) = run_git(dir, &["push", "origin", &branch])?;
    if !ok {
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            return Err(Error::Git("push_rejected".to_string()));
        }
        return Err(Error::Git(classify_git_error(&stderr)));
    }
    Ok(true)
}

/// Auto-resolve merge conflicts WITHOUT losing data (Bug #2, #26).
///
/// The previous implementation ran `git checkout --ours .`, which silently discarded
/// one entire side of every conflicted file — permanent data loss, and with a
/// direction that contradicted its own "most recent wins" comment. Instead, for each
/// conflicted file we keep BOTH versions: the local edit is preserved in place, and
/// the incoming (remote) version is written to a sibling `<name>.conflict-<host>.md`
/// copy so the user can review and merge manually. Nothing is destroyed.
///
/// During a rebase, `--theirs` is our local commit being replayed and `--ours` is the
/// upstream (remote) we're rebasing onto.
pub fn auto_resolve_conflicts(dir: &Path) -> Result<Vec<String>> {
    // List conflicted files
    let (stdout, _, _) = run_git(dir, &["diff", "--name-only", "--diff-filter=U"])?;
    let conflicted: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    if conflicted.is_empty() {
        return Ok(Vec::new());
    }

    let host = get_hostname();
    for file in &conflicted {
        // Save the upstream side (stage :2 = "ours" during rebase = the remote commit
        // we're rebasing onto) to a conflict copy so it isn't lost.
        let (other, _, ok) = run_git(dir, &["show", &format!(":2:{file}")])?;
        if ok && !other.is_empty() {
            if let Some(conflict_path) = conflict_copy_path(dir, file, &host) {
                let _ = std::fs::write(&conflict_path, other.as_bytes());
            }
        }
        // Keep our local edit (stage :3 = "theirs" during rebase) in the working tree.
        let _ = run_git(dir, &["checkout", "--theirs", "--", file]);
    }

    // Stage resolved files
    let (_, stderr, ok) = run_git(dir, &["add", "-A"])?;
    if !ok {
        return Err(Error::Git(format!("git add after resolve failed: {stderr}")));
    }

    // Continue the rebase (set GIT_EDITOR=true to prevent interactive editor hanging)
    let output = Command::new("git")
        .current_dir(dir)
        .args(["rebase", "--continue"])
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| Error::Git(format!("Failed to run git rebase --continue: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("No rebase in progress") {
            // If rebase --continue fails, try to just commit the resolution
            let _ = run_git(dir, &["commit", "--no-edit"]);
        }
    }

    Ok(conflicted)
}

/// Build the path for a conflict copy: `Notes.md` → `Notes.conflict-<host>.md`.
/// Returns None if the path can't be represented.
fn conflict_copy_path(dir: &Path, rel_file: &str, host: &str) -> Option<std::path::PathBuf> {
    let full = dir.join(rel_file);
    let stem = full.file_stem()?.to_string_lossy().to_string();
    let ext = full.extension().map(|e| e.to_string_lossy().to_string());
    let safe_host: String = host.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    let new_name = match ext {
        Some(e) => format!("{stem}.conflict-{safe_host}.{e}"),
        None => format!("{stem}.conflict-{safe_host}"),
    };
    Some(full.with_file_name(new_name))
}

/// Get the system hostname for commit messages.
pub fn get_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string())
}

// ── Internal helpers ──

/// Run a git command in the given directory. Returns (stdout, stderr, success).
fn run_git(dir: &Path, args: &[&str]) -> Result<(String, String, bool)> {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")  // Never prompt for credentials interactively
        .output()
        .map_err(|e| Error::Git(format!("Failed to run git: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((stdout, stderr, output.status.success()))
}

/// Classify a git error message into a user-friendly description.
fn classify_git_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("could not resolve hostname") || lower.contains("connection refused") {
        "Network error — check your internet connection".to_string()
    } else if lower.contains("permission denied") || lower.contains("authentication") {
        "Authentication failed — check your SSH keys or credentials".to_string()
    } else if lower.contains("not a git repository") {
        "Not a git repository".to_string()
    } else {
        stderr.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_git_available() {
        // git should be available in CI/dev environments
        assert!(git_available());
    }

    #[test]
    fn test_init_and_commit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();

        init_repo(path).unwrap();
        assert!(is_git_repo(path));
        assert!(!has_remote(path));

        // Create a file and commit
        std::fs::write(path.join("test.md"), "hello").unwrap();
        let committed = commit_all(path, "initial commit").unwrap();
        assert!(committed);

        // Second commit with no changes should return false
        let committed = commit_all(path, "no changes").unwrap();
        assert!(!committed);
    }

    #[test]
    fn test_branch_detection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();

        init_repo(path).unwrap();
        std::fs::write(path.join("test.md"), "hello").unwrap();
        commit_all(path, "initial").unwrap();

        let branch = get_branch(path).unwrap();
        assert!(branch.is_some());
        // Could be "main" or "master" depending on git config
    }

    #[test]
    fn test_get_hostname() {
        let h = get_hostname();
        assert!(!h.is_empty());
    }
}
