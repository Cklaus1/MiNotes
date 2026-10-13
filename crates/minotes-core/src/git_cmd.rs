//! System git wrapper — calls the `git` binary via `std::process::Command`.
//! No libgit2, no native deps. Inherits the user's SSH keys, credential helpers, and .gitconfig.
//!
//! ## What a sync repo may NOT make git do (F-6)
//!
//! A notebook folder can come from elsewhere (copied from another computer, a
//! shared drive, a zip). Its `notes/.git/` then carries someone else's hooks and
//! repo-local config — git never transfers those through a remote, so this is
//! about copied folders. Every git run here therefore overrides, on the command
//! line (which beats every config file):
//!
//! - `core.hooksPath` → `/dev/null` (Windows: an empty directory in MiNotes' own
//!   state dir): no hook in `.git/hooks/` ever runs; commits and pushes also pass
//!   `--no-verify`.
//! - `core.fsmonitor=false`: no fsmonitor command from the repo config.
//! - `protocol.ext.allow=never`: an `ext::<command>` remote URL can't run anything.
//! - `core.symlinks=false`: links in the tree are checked out as plain files
//!   (see the symlink rules in `repo::export`).
//! - `commit.gpgSign=false`: no `gpg.program` from the repo config (sync commits
//!   are machine-made; signing them was never a promise).
//!
//! Deliberately NOT overridden, so the user's own (global) setup keeps working:
//! `core.sshCommand`, `credential.helper`, `core.askPass`, proxies, the remote URL.
//! Those can also be set repo-locally, so a folder this machine did not set up
//! has them removed from `.git/config` before its first sync (see
//! [`strip_untrusted_config`]); a repo set up here keeps its own settings.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};

/// Hard ceiling for any single git invocation. Network commands that stall (dead
/// remote, hung SSH, credential helper waiting on input) are killed after this.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(120);
/// Upper bound on conflicting rebase steps resolved in one pull.
const MAX_REBASE_STEPS: usize = 50;

/// Check if git is installed on the system.
pub fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run `git init` in the given directory (creates dir + parents if needed).
/// New repos start on `main` so every device agrees on the branch name.
pub fn init_repo(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| Error::Git(format!("Cannot create {}: {e}", dir.display())))?;
    let (_, _, ok) = run_git(dir, &["init", "-b", "main"])?;
    if !ok {
        // git < 2.28 has no `-b`
        let (_, stderr, ok) = run_git(dir, &["init"])?;
        if !ok {
            return Err(Error::Git(format!("git init failed: {stderr}")));
        }
    }
    Ok(())
}

/// Check if the directory is a git repository.
pub fn is_git_repo(dir: &Path) -> bool {
    dir.join(".git").is_dir()
}

/// Is a rebase (merge or apply backend) in progress in this repo?
pub fn rebase_in_progress(dir: &Path) -> bool {
    let g = dir.join(".git");
    g.join("rebase-merge").exists() || g.join("rebase-apply").exists()
}

/// Abort a rebase left behind by a crashed/killed earlier sync. Nothing is lost:
/// aborting returns the branch to the local commit that was being replayed.
pub fn abort_stale_rebase(dir: &Path) -> Result<bool> {
    if !rebase_in_progress(dir) {
        return Ok(false);
    }
    eprintln!("[minotes-sync] aborting a stale rebase in {}", dir.display());
    let _ = run_git(dir, &["rebase", "--abort"])?;
    if rebase_in_progress(dir) {
        return Err(Error::Git("A rebase is in progress and could not be aborted".to_string()));
    }
    Ok(true)
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

/// Get the current branch name (works on an unborn branch too). Returns an error
/// while a rebase is in progress instead of guessing — HEAD is detached then, and
/// silently defaulting to "main" would pull/push the wrong branch.
pub fn get_branch(dir: &Path) -> Result<Option<String>> {
    if rebase_in_progress(dir) {
        return Err(Error::Git("A rebase is in progress in the sync directory".to_string()));
    }
    let (stdout, _, ok) = run_git(dir, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let branch = stdout.trim().to_string();
    if ok && !branch.is_empty() {
        Ok(Some(branch))
    } else {
        Ok(None)
    }
}

fn require_branch(dir: &Path) -> Result<String> {
    get_branch(dir)?.ok_or_else(|| Error::Git("Sync directory is on a detached HEAD".to_string()))
}

/// Current HEAD commit, or None on an unborn branch.
pub fn rev_parse_head(dir: &Path) -> Result<Option<String>> {
    let (stdout, _, ok) = run_git(dir, &["rev-parse", "-q", "--verify", "HEAD^{commit}"])?;
    let s = stdout.trim().to_string();
    Ok(if ok && !s.is_empty() { Some(s) } else { None })
}

/// Does `rev` name an existing commit?
pub fn commit_exists(dir: &Path, rev: &str) -> bool {
    run_git(dir, &["cat-file", "-e", &format!("{rev}^{{commit}}")])
        .map(|(_, _, ok)| ok)
        .unwrap_or(false)
}

/// Paths (relative, NUL-safe, unquoted) deleted between two commits.
pub fn deleted_files_between(dir: &Path, old: &str, new: &str) -> Result<Vec<String>> {
    let (stdout, stderr, ok) =
        run_git(dir, &["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", old, new])?;
    if !ok {
        return Err(Error::Git(format!("git diff failed: {stderr}")));
    }
    let mut out = Vec::new();
    let mut it = stdout.split('\0').filter(|s| !s.is_empty());
    while let Some(status) = it.next() {
        let Some(path) = it.next() else { break };
        if status.starts_with('D') {
            out.push(path.to_string());
        }
    }
    Ok(out)
}

/// Paths (relative, NUL-safe, unquoted) added, modified or deleted between two commits.
pub fn changed_files_between(dir: &Path, old: &str, new: &str) -> Result<Vec<String>> {
    let (stdout, stderr, ok) =
        run_git(dir, &["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", old, new])?;
    if !ok {
        return Err(Error::Git(format!("git diff failed: {stderr}")));
    }
    Ok(stdout.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// Contents of `path` at `rev` (None if absent).
pub fn show_file_at(dir: &Path, rev: &str, path: &str) -> Result<Option<String>> {
    let (stdout, _, ok) = run_git(dir, &["show", &format!("{rev}:{path}")])?;
    Ok(if ok { Some(stdout) } else { None })
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
    let (_, _, clean) = run_git(dir, &["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"])?;
    if clean {
        return Ok(false); // nothing staged → nothing to commit
    }

    // Commit
    let (stdout, stderr, ok) = run_git_committing(dir, &["commit", "--no-verify", "-m", message])?;
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
/// Returns Ok(true) on success, Ok(false) if the remote branch doesn't exist yet
/// (empty remote), Err("merge_conflict") if the rebase stopped on conflicts.
pub fn pull_rebase(dir: &Path) -> Result<bool> {
    let branch = require_branch(dir)?;
    let (stdout, stderr, ok) =
        run_git_committing(dir, &["pull", "--rebase", "--no-edit", "origin", &branch])?;
    if !ok {
        if rebase_in_progress(dir)
            || stderr.contains("CONFLICT")
            || stdout.contains("CONFLICT")
            || stderr.contains("could not apply")
        {
            return Err(Error::Git("merge_conflict".to_string()));
        }
        if stderr.contains("couldn't find remote ref") {
            return Ok(false); // nothing on the remote yet (first push pending)
        }
        // Network errors, auth errors, etc.
        return Err(Error::Git(classify_git_error(&stderr)));
    }
    Ok(true)
}

/// Push to the remote. Returns Ok(true) on success, Ok(false) if there is nothing
/// to push yet (no commits on the branch).
pub fn push(dir: &Path) -> Result<bool> {
    let branch = require_branch(dir)?;
    let (_, stderr, ok) = run_git(dir, &["push", "--no-verify", "origin", &branch])?;
    if !ok {
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            return Err(Error::Git("push_rejected".to_string()));
        }
        if stderr.contains("src refspec") && stderr.contains("does not match any") {
            return Ok(false);
        }
        return Err(Error::Git(classify_git_error(&stderr)));
    }
    Ok(true)
}

/// Unmerged (conflicted) paths — NUL-separated so non-ASCII names aren't quoted.
fn unmerged_files(dir: &Path) -> Result<Vec<String>> {
    let (stdout, _, _) = run_git(dir, &["diff", "--name-only", "-z", "--diff-filter=U", "--no-ext-diff"])?;
    let mut v: Vec<String> = stdout.split('\0').filter(|s| !s.is_empty()).map(String::from).collect();
    v.dedup();
    Ok(v)
}

/// Does this text contain git conflict markers at the start of a line?
pub fn has_conflict_markers(text: &str) -> bool {
    text.lines().any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> ") || l == "<<<<<<<" || l == ">>>>>>>")
}

fn abort_with(dir: &Path, msg: String) -> Error {
    let _ = run_git(dir, &["rebase", "--abort"]);
    Error::Git(msg)
}

/// Auto-resolve merge conflicts WITHOUT losing data (Bug #2, #26).
///
/// For each conflicted file we keep BOTH versions: the local edit stays in place,
/// and the incoming (remote) version is written to a sibling
/// `<name>.conflict-<host>.md`. That copy is rewritten to be a SEPARATE page (fresh
/// page id, title `"<title> (conflict from <host>)"`, fresh block ids), so on
/// import it becomes its own page instead of overwriting the original's blocks.
///
/// During a rebase, `--theirs` is our local commit being replayed and `--ours` is the
/// upstream (remote) we're rebasing onto. A multi-commit rebase can stop several
/// times; this loops (bounded) until the rebase completes. Before continuing, the
/// resolved files are checked for leftover conflict markers — if any remain the
/// rebase is aborted and an error returned rather than committing markers.
pub fn auto_resolve_conflicts(dir: &Path) -> Result<Vec<String>> {
    let host = get_hostname();
    let mut all_resolved: Vec<String> = Vec::new();

    for _ in 0..MAX_REBASE_STEPS {
        if !rebase_in_progress(dir) {
            return Ok(all_resolved);
        }
        let conflicted = unmerged_files(dir)?;
        for file in &conflicted {
            // Save the upstream side (stage :2) as a separate-page conflict copy.
            let (other, _, has_upstream) = run_git(dir, &["show", &format!(":2:{file}")])?;
            if has_upstream && !other.is_empty() {
                let copy_path = conflict_copy_path(dir, file, &host)
                    .ok_or_else(|| abort_with(dir, format!("Cannot build conflict copy path for {file}")))?;
                let body = if file.ends_with(".md") {
                    let stem = Path::new(file)
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "Untitled".to_string());
                    crate::repo::sync::rewrite_as_conflict_copy(&other, &stem, &host)
                } else {
                    other
                };
                let copy_rel = copy_path.strip_prefix(dir).unwrap_or(&copy_path).to_path_buf();
                if let Some(link) = crate::repo::export::symlink_below(dir, &copy_rel) {
                    return Err(abort_with(
                        dir,
                        format!("Not writing conflict copy {}: symbolic link at {}", copy_rel.display(), link.display()),
                    ));
                }
                if let Some(parent) = copy_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                crate::repo::export::atomic_write(&copy_path, body.as_bytes()).map_err(|e| {
                    abort_with(dir, format!("Failed to write conflict copy {}: {e}", copy_path.display()))
                })?;
            }
            // Keep our local edit (stage :3). If there is no local side (we deleted
            // it, they modified it), drop it — their version survives as the copy.
            let (_, _, ok) = run_git(dir, &["checkout", "--theirs", "--", file])?;
            if !ok {
                let _ = run_git(dir, &["rm", "-q", "--cached", "--ignore-unmatch", "--", file])?;
                if crate::repo::export::symlink_below(dir, Path::new(file).parent().unwrap_or(Path::new(""))).is_none() {
                    let _ = std::fs::remove_file(dir.join(file));
                }
            }
            all_resolved.push(file.clone());
        }

        // Never commit conflict markers.
        for file in &conflicted {
            if let Ok(text) = crate::repo::export::read_text_below(dir, Path::new(file)) {
                if has_conflict_markers(&text) {
                    return Err(abort_with(
                        dir,
                        format!("Unresolved conflict markers remain in {file}; rebase aborted"),
                    ));
                }
            }
        }

        let (_, stderr, ok) = run_git(dir, &["add", "-A"])?;
        if !ok {
            return Err(abort_with(dir, format!("git add after resolve failed: {stderr}")));
        }
        if !unmerged_files(dir)?.is_empty() {
            return Err(abort_with(dir, "Conflicts remain after auto-resolve; rebase aborted".into()));
        }

        let (_, stderr, ok) = run_git_committing(dir, &["rebase", "--continue"])?;
        if !ok && rebase_in_progress(dir) && unmerged_files(dir)?.is_empty() {
            // The step may have become empty after resolution: skip it only if
            // there is genuinely nothing staged; otherwise give up safely.
            let (_, _, clean) = run_git(dir, &["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"])?;
            if clean {
                let _ = run_git_committing(dir, &["rebase", "--skip"])?;
            } else {
                return Err(abort_with(dir, format!("git rebase --continue failed: {}", stderr.trim())));
            }
        }
    }

    if rebase_in_progress(dir) {
        return Err(abort_with(
            dir,
            format!("Rebase did not complete after {MAX_REBASE_STEPS} conflict steps; aborted"),
        ));
    }
    Ok(all_resolved)
}

/// Build the path for a conflict copy: `Notes.md` → `Notes.conflict-<host>.md`
/// (with `-2`, `-3`, … appended if that name already exists).
fn conflict_copy_path(dir: &Path, rel_file: &str, host: &str) -> Option<PathBuf> {
    let full = dir.join(rel_file);
    let stem = full.file_stem()?.to_string_lossy().to_string();
    let ext = full.extension().map(|e| e.to_string_lossy().to_string());
    let safe_host: String = host.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    for n in 1..1000 {
        let suffix = if n == 1 { String::new() } else { format!("-{n}") };
        let new_name = match &ext {
            Some(e) => format!("{stem}.conflict-{safe_host}{suffix}.{e}"),
            None => format!("{stem}.conflict-{safe_host}{suffix}"),
        };
        let p = full.with_file_name(new_name);
        if !p.exists() {
            return Some(p);
        }
    }
    None
}

/// Get the system hostname for commit messages.
pub fn get_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Make an existing (or new) sync repo safe to run git in: links in the tree
/// are checked out as plain files from now on (`core.symlinks=false`, persisted
/// so a manual `git checkout` in the folder behaves the same). Cheap and
/// idempotent; called on enable and before every sync cycle.
pub fn harden_repo(dir: &Path) -> Result<()> {
    let (cur, _, _) = run_git(dir, &["config", "--local", "--get", "core.symlinks"])?;
    if cur.trim() != "false" {
        let (_, stderr, ok) = run_git(dir, &["config", "--local", "core.symlinks", "false"])?;
        if !ok {
            return Err(Error::Git(format!("git config failed: {}", stderr.trim())));
        }
    }
    Ok(())
}

/// Repo-local config keys that make git run a program (or pull in another
/// config file). A folder this machine did not set up must not bring them.
pub fn is_command_config_key(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let parts: Vec<&str> = n.split('.').collect();
    let first = parts.first().copied().unwrap_or("");
    let last = parts.last().copied().unwrap_or("");
    matches!(
        n.as_str(),
        "core.fsmonitor"
            | "core.hookspath"
            | "core.sshcommand"
            | "core.askpass"
            | "core.gitproxy"
            | "core.pager"
            | "core.editor"
            | "core.alternaterefscommand"
            | "sequence.editor"
            | "diff.external"
            | "gpg.program"
            | "uploadpack.packobjectshook"
            | "credential.helper"
    ) || first == "include"
        || first == "includeif"
        || first == "pager"
        || first == "alias"
        || (first == "credential" && last == "helper")
        || (first == "gpg" && last == "program")
        || (first == "filter" && matches!(last, "clean" | "smudge" | "process"))
        || (first == "merge" && last == "driver")
        || (first == "diff" && matches!(last, "command" | "textconv"))
        || (first == "remote" && matches!(last, "uploadpack" | "receivepack" | "proxy"))
        || (first == "http" && last == "proxy")
}

/// Remove [`is_command_config_key`] keys from the repo's own `.git/config`
/// (never the user's global config). For a sync folder this machine did not
/// set up — copied from elsewhere — before its first sync here. Returns the
/// keys removed.
pub fn strip_untrusted_config(dir: &Path) -> Result<Vec<String>> {
    let (out, _, ok) = run_git(dir, &["config", "--local", "--no-includes", "--name-only", "--list"])?;
    if !ok {
        return Ok(vec![]);
    }
    let mut removed: Vec<String> = Vec::new();
    for name in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if is_command_config_key(name) && !removed.iter().any(|r| r.eq_ignore_ascii_case(name)) {
            let (_, stderr, ok) = run_git(dir, &["config", "--local", "--unset-all", name])?;
            if !ok && !stderr.trim().is_empty() {
                return Err(Error::Git(format!("Could not remove {name} from the sync folder's git config: {}", stderr.trim())));
            }
            removed.push(name.to_string());
        }
    }
    if !removed.is_empty() {
        eprintln!("[minotes-sync] removed from {}/.git/config: {}", dir.display(), removed.join(", "));
    }
    Ok(removed)
}

// ── Internal helpers ──

/// Where hooks are looked up: nowhere. `/dev/null` is not a directory, so no
/// hook can exist under it (Git for Windows maps `/dev/null` too, but an empty
/// directory in MiNotes' own state dir is used there to be certain).
fn no_hooks_path() -> &'static str {
    static P: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    P.get_or_init(|| {
        #[cfg(windows)]
        {
            let d = crate::notebook::base_dir().join("git-no-hooks");
            let _ = std::fs::create_dir_all(&d);
            // Anything that appeared in it is not ours: empty it.
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    let _ = std::fs::remove_file(e.path());
                }
            }
            d.display().to_string()
        }
        #[cfg(not(windows))]
        {
            "/dev/null".to_string()
        }
    })
}

/// The `-c` overrides every git run gets (see the module docs).
fn safety_args() -> Vec<String> {
    vec![
        "-c".into(),
        "core.quotePath=off".into(),
        "-c".into(),
        format!("core.hooksPath={}", no_hooks_path()),
        "-c".into(),
        "core.fsmonitor=false".into(),
        "-c".into(),
        "protocol.ext.allow=never".into(),
        "-c".into(),
        "core.symlinks=false".into(),
        "-c".into(),
        "commit.gpgSign=false".into(),
    ]
}

/// Name and address for MiNotes' own commits when the user has no git identity
/// (no `user.name` / `user.email` in the repo, global or system config, nor in
/// the `GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `EMAIL` environment). Git would
/// otherwise refuse to commit ("unable to auto-detect email address") on a
/// machine whose hostname has no domain. Nothing personal is guessed: the name
/// is "MiNotes", the address `minotes@<hostname>.local`. A configured identity
/// always wins.
fn fallback_identity(dir: &Path) -> Vec<String> {
    let configured = |key: &str, envs: &[&str]| {
        envs.iter().any(|e| std::env::var(e).map(|v| !v.trim().is_empty()).unwrap_or(false))
            || run_git(dir, &["config", "--get", key]).map(|(o, _, ok)| ok && !o.trim().is_empty()).unwrap_or(false)
    };
    let mut out = Vec::new();
    if !configured("user.name", &["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) {
        out.push("-c".to_string());
        out.push("user.name=MiNotes".to_string());
    }
    if !configured("user.email", &["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
        let host: String = get_hostname()
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
            .collect();
        let host = host.trim_matches('-');
        let host = if host.is_empty() { "localhost" } else { host };
        out.push("-c".to_string());
        out.push(format!("user.email=minotes@{host}.local"));
    }
    out
}

/// [`run_git`] for commands that make commits (commit, pull --rebase, rebase
/// --continue/--skip): with [`fallback_identity`] when the user has none.
fn run_git_committing(dir: &Path, args: &[&str]) -> Result<(String, String, bool)> {
    let ident = fallback_identity(dir);
    let mut all: Vec<&str> = ident.iter().map(String::as_str).collect();
    all.extend_from_slice(args);
    run_git(dir, &all)
}

/// Run a git command in the given directory. Returns (stdout, stderr, success).
pub(crate) fn run_git(dir: &Path, args: &[&str]) -> Result<(String, String, bool)> {
    run_git_timeout(dir, args, GIT_TIMEOUT)
}

/// Run git with a watchdog: the child is killed if it outlives `timeout`.
/// Never prompts (terminal/editor), and paths are printed unquoted.
pub(crate) fn run_git_timeout(dir: &Path, args: &[&str], timeout: Duration) -> Result<(String, String, bool)> {
    let mut child = Command::new("git")
        .current_dir(dir)
        .args(safety_args())
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0") // Never prompt for credentials interactively
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        // Abort HTTP transfers that stall below 1 KB/s for 30 s.
        .env("GIT_HTTP_LOW_SPEED_LIMIT", "1000")
        .env("GIT_HTTP_LOW_SPEED_TIME", "30")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Git(format!("Failed to run git: {e}")))?;

    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut v);
        }
        v
    });
    let err_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut v);
        }
        v
    });

    let start = Instant::now();
    let mut delay = Duration::from_millis(1);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    // Don't join the readers: a grandchild (ssh) may still hold the pipes.
                    return Err(Error::Git(format!(
                        "git {} timed out after {}s",
                        args.first().copied().unwrap_or(""),
                        timeout.as_secs()
                    )));
                }
                std::thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_millis(25));
            }
            Err(e) => return Err(Error::Git(format!("Failed waiting for git: {e}"))),
        }
    };
    let stdout = String::from_utf8_lossy(&out_t.join().unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&err_t.join().unwrap_or_default()).to_string();
    Ok((stdout, stderr, status.success()))
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
pub(crate) mod tests {
    use super::*;

    /// Configure a throwaway repo so commits work regardless of global git config.
    pub(crate) fn configure_test_repo(dir: &Path) {
        for (k, v) in [
            ("user.email", "test@example.com"),
            ("user.name", "MiNotes Test"),
            ("commit.gpgsign", "false"),
            ("pull.rebase", "true"),
        ] {
            let (_, e, ok) = run_git(dir, &["config", k, v]).unwrap();
            assert!(ok, "git config {k}: {e}");
        }
    }

    /// A bare remote plus two clones-to-be ("devices") wired to it as origin.
    pub(crate) fn setup_remote_and_devices(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let remote = root.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        let (_, e, ok) = run_git(&remote, &["init", "--bare", "-q"]).unwrap();
        assert!(ok, "{e}");
        let mut devs = Vec::new();
        for name in ["device-a", "device-b"] {
            let d = root.join(name);
            init_repo(&d).unwrap();
            configure_test_repo(&d);
            let (_, e, ok) = run_git(&d, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
            assert!(ok, "{e}");
            devs.push(d);
        }
        (remote, devs.remove(0), devs.remove(0))
    }

    // A machine with no git identity at all (no global/system config, nothing in
    // the environment, a hostname without a domain): MiNotes' commits still work
    // under a neutral fallback identity, and a configured identity always wins.
    #[test]
    fn test_commit_without_any_git_identity() {
        if !git_available() {
            return;
        }
        let _home = crate::notebook::tests::FakeHome::new(); // empty HOME: no ~/.gitconfig
        let saved: Vec<(&str, Option<std::ffi::OsString>)> =
            ["GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL", "XDG_CONFIG_HOME"]
                .into_iter()
                .map(|k| (k, std::env::var_os(k)))
                .collect();
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        for (k, _) in &saved[1..] {
            std::env::remove_var(k);
        }
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        let r = commit_all(dir.path(), "first");
        let (log, _, _) = run_git(dir.path(), &["log", "-1", "--format=%an <%ae>"]).unwrap();
        // Configured identity wins.
        run_git(dir.path(), &["config", "user.name", "Real Person"]).unwrap();
        run_git(dir.path(), &["config", "user.email", "real@example.com"]).unwrap();
        std::fs::write(dir.path().join("b.md"), "y").unwrap();
        let r2 = commit_all(dir.path(), "second");
        let (log2, _, _) = run_git(dir.path(), &["log", "-1", "--format=%an <%ae>"]).unwrap();
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        assert!(r.unwrap(), "commit with no identity configured");
        assert!(log.trim().starts_with("MiNotes <minotes@") && log.trim().ends_with(".local>"), "{log}");
        assert!(r2.unwrap());
        assert_eq!(log2.trim(), "Real Person <real@example.com>");
    }

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
        configure_test_repo(path);
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
        configure_test_repo(path);
        // Unborn branch is still detected (symbolic-ref), not defaulted.
        assert!(get_branch(path).unwrap().is_some());
        std::fs::write(path.join("test.md"), "hello").unwrap();
        commit_all(path, "initial").unwrap();

        let branch = get_branch(path).unwrap();
        assert!(branch.is_some());
    }

    // #12: while a rebase is in progress, get_branch must error, not guess "main".
    #[test]
    fn test_get_branch_errors_during_rebase() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        std::fs::create_dir_all(dir.path().join(".git/rebase-merge")).unwrap();
        assert!(get_branch(dir.path()).is_err());
        assert!(pull_rebase(dir.path()).is_err());
    }

    #[test]
    fn test_get_hostname() {
        let h = get_hostname();
        assert!(!h.is_empty());
    }

    #[test]
    fn test_git_timeout_kills_child() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        // With a 0s budget the watchdog fires (or git finishes first); either way
        // the call must return promptly with an error or a result, never hang.
        let start = Instant::now();
        let _ = run_git_timeout(dir.path(), &["status"], Duration::from_secs(0));
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    fn page_md(id: &str, title: &str, block_id: &str, text: &str) -> String {
        format!("---\nid: {id}\ntitle: \"{title}\"\n---\n\n- {text} <!-- id:{block_id} -->\n")
    }

    // #3 + #6: conflicts on a non-ASCII filename resolve (no quoted-path failure),
    // no markers are committed, and the remote side becomes a separate page.
    #[test]
    fn test_conflict_non_ascii_resolves_and_copy_is_separate_page() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        let pid = uuid::Uuid::now_v7().to_string();
        let bid = uuid::Uuid::now_v7().to_string();
        let name = "Café ü 日本.md";

        std::fs::write(a.join(name), page_md(&pid, "Café ü 日本", &bid, "base")).unwrap();
        commit_all(&a, "base").unwrap();
        push(&a).unwrap();
        pull_rebase(&b).unwrap();

        std::fs::write(a.join(name), page_md(&pid, "Café ü 日本", &bid, "from A")).unwrap();
        commit_all(&a, "a edit").unwrap();
        push(&a).unwrap();

        std::fs::write(b.join(name), page_md(&pid, "Café ü 日本", &bid, "from B")).unwrap();
        commit_all(&b, "b edit").unwrap();
        let err = pull_rebase(&b).unwrap_err();
        assert!(err.to_string().contains("merge_conflict"), "{err}");

        let resolved = auto_resolve_conflicts(&b).unwrap();
        assert_eq!(resolved, vec![name.to_string()]);
        assert!(!rebase_in_progress(&b));
        let kept = std::fs::read_to_string(b.join(name)).unwrap();
        assert!(kept.contains("from B") && !has_conflict_markers(&kept), "{kept}");

        let copy_name = std::fs::read_dir(&b)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .find(|n| n.contains(".conflict-"))
            .expect("conflict copy written");
        let copy = std::fs::read_to_string(b.join(&copy_name)).unwrap();
        assert!(copy.contains("from A"));
        let fm = crate::repo::sync::parse_frontmatter(&copy);
        assert_ne!(fm.id.unwrap().to_string(), pid, "copy must get a fresh page id");
        assert!(fm.title.unwrap().contains("(conflict from"));
        assert!(!copy.contains(&bid), "the copy must not reuse the original block ids");
        assert!(copy.contains("<!-- id:"), "the copy carries its own fixed block ids");
        // Committed tree has no markers.
        let (log, _, _) = run_git(&b, &["show", "HEAD"]).unwrap();
        assert!(!has_conflict_markers(&log));
    }

    // #12: a rebase with several conflicting local commits is fully resolved.
    #[test]
    fn test_multi_step_rebase_resolves_every_step() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (_remote, a, b) = setup_remote_and_devices(tmp.path());
        std::fs::write(a.join("one.md"), "- base 1\n").unwrap();
        std::fs::write(a.join("two.md"), "- base 2\n").unwrap();
        commit_all(&a, "base").unwrap();
        push(&a).unwrap();
        pull_rebase(&b).unwrap();

        std::fs::write(a.join("one.md"), "- A 1\n").unwrap();
        std::fs::write(a.join("two.md"), "- A 2\n").unwrap();
        commit_all(&a, "a").unwrap();
        push(&a).unwrap();

        std::fs::write(b.join("one.md"), "- B 1\n").unwrap();
        commit_all(&b, "b1").unwrap();
        std::fs::write(b.join("two.md"), "- B 2\n").unwrap();
        commit_all(&b, "b2").unwrap();

        assert!(pull_rebase(&b).is_err());
        let resolved = auto_resolve_conflicts(&b).unwrap();
        assert_eq!(resolved.len(), 2, "{resolved:?}");
        assert!(!rebase_in_progress(&b));
        assert_eq!(get_branch(&b).unwrap().as_deref(), Some("main"));
        assert_eq!(std::fs::read_to_string(b.join("one.md")).unwrap(), "- B 1\n");
        assert_eq!(std::fs::read_to_string(b.join("two.md")).unwrap(), "- B 2\n");
        push(&b).unwrap();
    }

    #[test]
    fn test_deleted_files_between_is_nul_safe() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p).unwrap();
        configure_test_repo(p);
        std::fs::write(p.join("naïve file.md"), "x").unwrap();
        std::fs::write(p.join("keep.md"), "y").unwrap();
        commit_all(p, "1").unwrap();
        let old = rev_parse_head(p).unwrap().unwrap();
        std::fs::remove_file(p.join("naïve file.md")).unwrap();
        commit_all(p, "2").unwrap();
        let new = rev_parse_head(p).unwrap().unwrap();
        assert_eq!(deleted_files_between(p, &old, &new).unwrap(), vec!["naïve file.md".to_string()]);
    }
}
