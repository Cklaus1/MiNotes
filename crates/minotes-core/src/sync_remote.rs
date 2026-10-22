//! Setting up git sync from the app (UX review Wave 4, C-17): the remote's
//! address, "Test connection", "Set up sync", changing or removing the remote,
//! and "Join an existing notebook…" (a plain or an encrypted one).
//!
//! **Credentials** are never MiNotes' business: git uses the user's SSH keys /
//! agent and credential helpers, prompts are off (`GIT_TERMINAL_PROMPT=0`), and
//! an address with a password or token in it is refused — git would store it
//! in the sync folder's `.git/config`.
//!
//! **Addresses** ([`validate_remote`]): `https://`, `http://`, `ssh://`,
//! scp-like `user@host:path`, `file://` and local paths. Never a remote helper
//! (`ext::…`, `fd::…`: they run programs), never an option (`-…`), never
//! control characters. A local path must be in the home folder (not a hidden
//! top-level folder like `~/.ssh`) or on an external drive — or a folder the
//! user picked in the native folder picker (the app passes those in).
//!
//! **Test connection** ([`check_remote`]) runs `git ls-remote` from an empty
//! scratch folder with the usual safety options and a short timeout, and says
//! which of reachable / empty / not found / sign-in refused / not a git
//! repository / offline / timeout it is.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::git_cmd;

/// How long "Test connection" waits for an answer.
pub const REMOTE_TEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Error code of [`join_plain`] for a remote that holds an encrypted notebook
/// (the app then asks for the passphrase).
pub const ENCRYPTED_REMOTE: &str = "ENCRYPTED_REMOTE";

/// Where a local-path remote may live.
#[derive(Debug, Clone, Default)]
pub struct LocalRoots {
    /// Home folders (the home dir; on WSL also the Windows profile).
    pub homes: Vec<PathBuf>,
    /// Folders the user chose in the native picker (any location).
    pub picked: Vec<PathBuf>,
}

impl LocalRoots {
    pub fn home() -> Self {
        LocalRoots { homes: vec![crate::notebook::home_dir()], picked: vec![] }
    }
}

/// A validated remote address.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValidRemote {
    /// What git is given (a local path is made absolute and canonical).
    pub url: String,
    /// "https", "http", "ssh", "scp", "file" or "local".
    pub kind: &'static str,
    /// For "file" / "local".
    #[serde(skip)]
    pub local_path: Option<PathBuf>,
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::InvalidInput(msg.into())
}

/// Is `s` an scp-like `[user@]host:path` address (not a Windows drive path)?
fn scp_like(s: &str) -> Option<(&str, &str)> {
    if s.contains("://") {
        return None;
    }
    let colon = s.find(':')?;
    let (host, path) = (&s[..colon], &s[colon + 1..]);
    if host.contains('/') || host.contains('\\') || host.len() < 2 && host.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some((host, path))
}

fn check_host(host: &str) -> Result<()> {
    let h = host.rsplit('@').next().unwrap_or(host);
    if h.is_empty() || h.starts_with('-') || h.chars().any(|c| c.is_whitespace()) {
        return Err(invalid("That address has no valid server name"));
    }
    Ok(())
}

/// Validate a remote address typed (or picked) by the user. See the module docs.
pub fn validate_remote(raw: &str, roots: &LocalRoots) -> Result<ValidRemote> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(invalid("Enter the address of the git repository"));
    }
    if s.chars().any(|c| c.is_control()) {
        return Err(invalid("The address contains a control character"));
    }
    if s.starts_with('-') {
        return Err(invalid("An address can't start with “-”"));
    }
    // `<helper>::<address>` (ext::, fd::, …) makes git run a remote helper program.
    if let Some(i) = s.find("::") {
        let scheme = &s[..i];
        if !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return Err(invalid(format!(
                "“{scheme}::” addresses run a program on this computer — not allowed. Use https://, ssh:// or user@host:path"
            )));
        }
    }
    if let Some(i) = s.find("://") {
        let scheme = s[..i].to_ascii_lowercase();
        let rest = &s[i + 3..];
        let kind = match scheme.as_str() {
            "https" => "https",
            "http" => "http",
            "ssh" | "git+ssh" | "ssh+git" => "ssh",
            "file" => {
                let path = rest.strip_prefix("localhost").unwrap_or(rest);
                return validate_local(path, roots, "file");
            }
            "git" => return Err(invalid("git:// addresses can't receive pushes — use the ssh:// or https:// address of the repository")),
            other => return Err(invalid(format!("“{other}://” is not a supported address type — use https://, ssh:// or user@host:path"))),
        };
        if s.chars().any(char::is_whitespace) {
            return Err(invalid("A web or SSH address can't contain spaces"));
        }
        let (authority, path) = match rest.find('/') {
            Some(j) => (&rest[..j], &rest[j..]),
            None => (rest, ""),
        };
        if let Some(at) = authority.rfind('@') {
            if authority[..at].contains(':') {
                return Err(invalid(
                    "Don't put a password or token in the address: MiNotes would have to store it. Remove it — git signs in with your credential helper or SSH key",
                ));
            }
        }
        check_host(authority.split(':').next().unwrap_or(""))?;
        if path.trim_matches('/').is_empty() {
            return Err(invalid("The address needs the repository's path (…/owner/notes.git)"));
        }
        return Ok(ValidRemote { url: s.to_string(), kind, local_path: None });
    }
    if let Some((host, path)) = scp_like(s) {
        if s.chars().any(char::is_whitespace) {
            return Err(invalid("An SSH address can't contain spaces"));
        }
        check_host(host)?;
        if path.trim_matches('/').is_empty() {
            return Err(invalid("The address needs the repository's path (git@host:owner/notes.git)"));
        }
        return Ok(ValidRemote { url: s.to_string(), kind: "scp", local_path: None });
    }
    validate_local(s, roots, "local")
}

/// Canonical form of `p` (existing prefix canonicalized, the rest appended).
fn canonical_lenient(p: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(p) {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => canonical_lenient(parent).join(name),
        _ => p.to_path_buf(),
    }
}

fn validate_local(raw: &str, roots: &LocalRoots, kind: &'static str) -> Result<ValidRemote> {
    let expanded = if raw == "~" {
        crate::notebook::home_dir()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        crate::notebook::home_dir().join(rest)
    } else {
        PathBuf::from(raw)
    };
    if !expanded.is_absolute() {
        return Err(invalid("Enter a web address (https://…), an SSH address (user@host:path) or a full folder path"));
    }
    if expanded.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(invalid("The folder path must not contain “..”"));
    }
    let canon = canonical_lenient(&expanded);
    let ok = |canon: &Path| -> bool {
        if roots.picked.iter().any(|p| canon.starts_with(canonical_lenient(p))) {
            return true;
        }
        for home in &roots.homes {
            let home = canonical_lenient(home);
            if let Ok(rel) = canon.strip_prefix(&home) {
                return match rel.components().next() {
                    Some(Component::Normal(first)) => {
                        let f = first.to_string_lossy();
                        !f.starts_with('.') && !f.eq_ignore_ascii_case("AppData")
                    }
                    _ => false, // the home folder itself
                };
            }
        }
        let s = canon.to_string_lossy();
        ["/media/", "/mnt/", "/run/media/", "/Volumes/"].iter().any(|d| s.starts_with(d)) && canon.components().count() > 3
    };
    if !ok(&canon) {
        return Err(invalid(
            "That folder is outside your home folder (or in a hidden one). Choose it with “Choose folder…” to use it anyway",
        ));
    }
    Ok(ValidRemote { url: canon.to_string_lossy().to_string(), kind, local_path: Some(canon) })
}

/// The answer to "Test connection".
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RemoteCheck {
    /// "reachable" | "empty" | "not_found" | "auth" | "not_a_repo" | "offline"
    /// | "timeout" | "invalid" | "other".
    pub status: &'static str,
    /// One sentence for the user.
    pub message: String,
    /// Branches on the remote.
    pub branches: Vec<String>,
    /// The remote's default branch (its HEAD), if it says.
    pub default_branch: Option<String>,
    /// Works, but… (a non-bare repository: pushes to its checked-out branch fail).
    pub warning: Option<String>,
    /// The address as git gets it (canonical for a local folder).
    pub url: String,
}

impl RemoteCheck {
    pub fn usable(&self) -> bool {
        matches!(self.status, "reachable" | "empty")
    }
    fn fail(status: &'static str, message: impl Into<String>, url: &str) -> Self {
        RemoteCheck { status, message: message.into(), branches: vec![], default_branch: None, warning: None, url: url.to_string() }
    }
}

/// Classify a failed `git ls-remote`'s stderr: (status, message).
pub fn classify_remote_failure(stderr: &str) -> (&'static str, String) {
    let l = stderr.to_lowercase();
    if l.contains("timed out after") && l.contains("git ls-remote") {
        return ("timeout", "No answer from the server in time — check the address and your network".into());
    }
    if l.contains("host key verification failed") || l.contains("remote host identification has changed") {
        return (
            "auth",
            "This computer doesn't know the server's SSH host key yet. Connect once in a terminal (ssh to that server) to check and accept it, then test again".into(),
        );
    }
    if l.contains("not valid: is this a git repository")
        || l.contains("not a git repository")
        || l.contains("invalid server response")
        || l.contains("protocol error: bad line length")
        || l.contains("unexpected end of file")
    {
        return ("not_a_repo", "Something answers at that address, but it isn't a git repository".into());
    }
    match crate::sync_manager::sync_error_kind(stderr) {
        crate::sync_manager::SYNC_ERR_AUTH => (
            "auth",
            "Sign-in refused. MiNotes uses your computer's git setup: check your SSH key (and ssh-agent) or git's credential helper for this server".into(),
        ),
        crate::sync_manager::SYNC_ERR_REMOTE_NOT_FOUND => (
            "not_found",
            "Not found — no git repository at that address (moved, deleted, mistyped — or private and you're not signed in)".into(),
        ),
        crate::sync_manager::SYNC_ERR_OFFLINE => ("offline", "Can't reach the server — check the address and your network".into()),
        _ => {
            let first = stderr.lines().map(str::trim).find(|x| !x.is_empty()).unwrap_or("git failed");
            ("other", first.strip_prefix("fatal: ").unwrap_or(first).to_string())
        }
    }
}

/// Parse `git ls-remote --symref` output: (branches, default branch).
fn parse_ls_remote(out: &str) -> (Vec<String>, Option<String>) {
    let mut branches = Vec::new();
    let mut default = None;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("ref: ") {
            let mut it = rest.split('\t');
            if let (Some(target), Some("HEAD")) = (it.next(), it.next()) {
                default = target.strip_prefix("refs/heads/").map(str::to_string);
            }
            continue;
        }
        if let Some((_, r)) = line.split_once('\t') {
            if let Some(b) = r.strip_prefix("refs/heads/") {
                if !branches.iter().any(|x| x == b) {
                    branches.push(b.to_string());
                }
            }
        }
    }
    (branches, default)
}

/// "Test connection" for a validated address (never an error: the answer says).
pub fn check_valid_remote(v: &ValidRemote, timeout: Duration) -> RemoteCheck {
    let mut warning = None;
    if let Some(p) = &v.local_path {
        if !p.exists() {
            return RemoteCheck::fail("not_found", format!("Not found — nothing at {}. Check the folder path", p.display()), &v.url);
        }
        if !p.is_dir() {
            return RemoteCheck::fail("not_a_repo", format!("{} is a file, not a git repository", p.display()), &v.url);
        }
        let bare = p.join("HEAD").is_file() && p.join("objects").is_dir();
        if !bare && !p.join(".git").exists() {
            return RemoteCheck::fail(
                "not_a_repo",
                format!("{} is a folder, but not a git repository. Create one there with “git init --bare”", p.display()),
                &v.url,
            );
        }
        if !bare {
            warning = Some(
                "This is a working folder, not a bare repository: git refuses pushes to its checked-out branch. A bare one (“git init --bare”) is safer".into(),
            );
        }
    }
    match git_cmd::ls_remote(&v.url, timeout) {
        Err(e) => {
            let (status, message) = classify_remote_failure(&e.to_string());
            RemoteCheck::fail(status, message, &v.url)
        }
        Ok((_, stderr, false)) => {
            let (status, message) = classify_remote_failure(&stderr);
            RemoteCheck::fail(status, message, &v.url)
        }
        Ok((stdout, _, true)) => {
            let (branches, default_branch) = parse_ls_remote(&stdout);
            let (status, message) = if branches.is_empty() {
                ("empty", "Reachable — an empty repository. “Set up sync” sends this notebook there".to_string())
            } else {
                (
                    "reachable",
                    format!(
                        "Reachable — it already holds notes ({} branch{}: {})",
                        branches.len(),
                        if branches.len() == 1 { "" } else { "es" },
                        branches.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
                    ),
                )
            };
            RemoteCheck { status, message, branches, default_branch, warning, url: v.url.clone() }
        }
    }
}

/// [`validate_remote`] + [`check_valid_remote`].
pub fn check_remote(raw: &str, roots: &LocalRoots, timeout: Duration) -> RemoteCheck {
    match validate_remote(raw, roots) {
        Ok(v) => check_valid_remote(&v, timeout),
        Err(e) => RemoteCheck::fail("invalid", user_message(&e), raw.trim()),
    }
}

/// An error's text for the user ("Invalid input: " / "Git error: " dropped).
pub fn user_message(e: &Error) -> String {
    let s = e.to_string();
    for p in ["Invalid input: ", "Git error: "] {
        if let Some(r) = s.strip_prefix(p) {
            return r.to_string();
        }
    }
    s
}

/// A local remote inside the notebook's own folders would sync into itself.
fn refuse_self(v: &ValidRemote, sync_dir: &Path) -> Result<()> {
    if let Some(p) = &v.local_path {
        let dir = canonical_lenient(sync_dir);
        // A folder notebook's root holds its database next to `notes/`.
        let root = dir.parent().map(Path::to_path_buf).filter(|r| r.join(crate::notebook::DB_FILE).exists());
        if p.starts_with(&dir) || dir.starts_with(p) || root.map(|r| p.starts_with(r)).unwrap_or(false) {
            return Err(invalid("That folder is part of this notebook — choose a repository outside it"));
        }
    }
    Ok(())
}

/// Validate and test `raw` for a notebook whose sync folder is `sync_dir`:
/// the address to store, or the reason it can't be used.
pub fn usable_remote(raw: &str, roots: &LocalRoots, sync_dir: &Path) -> Result<(ValidRemote, RemoteCheck)> {
    let v = validate_remote(raw, roots)?;
    refuse_self(&v, sync_dir)?;
    let check = check_valid_remote(&v, REMOTE_TEST_TIMEOUT);
    if !check.usable() {
        return Err(Error::Git(check.message.clone()));
    }
    Ok((v, check))
}

/// "Join an existing notebook…" for a plain notebook: fetch the remote into a
/// new folder notebook at `root` (its `notes/` becomes the fetched repo). Does
/// not switch or turn sync on — the app then switches and turns sync on, which
/// imports everything (as a fresh device joins). Refused with
/// [`ENCRYPTED_REMOTE`] for an encrypted notebook's remote (the passphrase is
/// needed: `sync_encrypted::join_from_remote`), and for an empty remote.
/// Nothing is written to the remote; a failure creates nothing.
pub fn join_plain(raw: &str, roots: &LocalRoots, root: &Path, name: &str) -> Result<crate::notebook::Notebook> {
    crate::notebook::validate_name(name)?;
    let v = validate_remote(raw, roots)?;
    if root.exists() && std::fs::read_dir(root).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(Error::AlreadyExists(format!("{} already exists and is not empty — choose a new folder", root.display())));
    }
    let existed = root.exists();
    let check = check_valid_remote(&v, REMOTE_TEST_TIMEOUT);
    match check.status {
        "reachable" => {}
        "empty" => {
            return Err(invalid(
                "That repository is empty — there is no notebook to join yet. On the device that has the notes, use Settings → Sync & Backup → Set up sync first",
            ))
        }
        _ => return Err(Error::Git(check.message)),
    }
    let branch = check
        .default_branch
        .clone()
        .filter(|b| check.branches.contains(b))
        .or_else(|| check.branches.iter().find(|b| *b == "main").cloned())
        .unwrap_or_else(|| check.branches[0].clone());
    let parent = root.parent().ok_or_else(|| invalid("Choose a folder for the notebook"))?;
    std::fs::create_dir_all(parent).map_err(|e| invalid(format!("Cannot create {}: {e}", parent.display())))?;
    let staging = parent.join(format!(".minotes-join-{}", Uuid::now_v7().simple()));
    let result = (|| {
        git_cmd::init_repo(&staging)?;
        git_cmd::harden_repo(&staging)?;
        // The local branch is the remote's (an older repo may use "master").
        let (_, e, ok) = git_cmd::run_git(&staging, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;
        if !ok {
            return Err(Error::Git(format!("Cannot use the branch “{branch}”: {}", e.trim())));
        }
        git_cmd::set_remote_url(&staging, &v.url)?;
        let (_, stderr, ok) = git_cmd::run_git(&staging, &["fetch", "--no-tags", "origin", &branch])?;
        if !ok {
            return Err(Error::Git(classify_remote_failure(&stderr).1));
        }
        if git_cmd::show_file_at(&staging, "FETCH_HEAD", crate::sync_encrypted::KEY_FILE)?.is_some() {
            return Err(invalid(format!(
                "{ENCRYPTED_REMOTE}: This notebook is encrypted — enter its passphrase (or recovery key) to join it"
            )));
        }
        let nb = crate::notebook::create_in_folder(root, name)?;
        let notes = nb.mirror_dir();
        let _ = std::fs::remove_dir_all(&notes);
        std::fs::rename(&staging, &notes).map_err(|e| invalid(format!("Cannot move the sync folder: {e}")))?;
        Ok(nb)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
        // The notebook folder was missing or empty: whatever is in it now is ours.
        if !existed {
            let _ = std::fs::remove_dir_all(root);
        }
    }
    result
}

#[cfg(test)]
mod tests;
