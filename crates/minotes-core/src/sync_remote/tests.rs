use std::path::{Path, PathBuf};

use super::*;
use crate::db::Database;
use crate::notebook::tests::FakeHome;
use crate::sync_manager;

fn roots(home: &Path) -> LocalRoots {
    LocalRoots { homes: vec![home.to_path_buf()], picked: vec![] }
}

fn bare(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    let (_, e, ok) = git_cmd::run_git(path, &["init", "--bare", "-q", "-b", "main"]).unwrap();
    assert!(ok, "{e}");
    path.to_path_buf()
}

fn err_of(r: Result<ValidRemote>) -> String {
    user_message(&r.expect_err("should be refused"))
}

#[test]
fn accepts_the_usual_addresses() {
    let h = FakeHome::new();
    let r = roots(h.path());
    for (url, kind) in [
        ("https://github.com/me/notes.git", "https"),
        ("http://nas.local:3000/me/notes.git", "http"),
        ("ssh://git@example.com:2222/me/notes.git", "ssh"),
        ("git@github.com:me/notes.git", "scp"),
        ("nas:notes.git", "scp"),
    ] {
        let v = validate_remote(&format!("  {url} "), &r).unwrap_or_else(|e| panic!("{url}: {e}"));
        assert_eq!((v.url.as_str(), v.kind), (url, kind));
    }
    let repo = h.path().join("Repos/notes.git");
    std::fs::create_dir_all(&repo).unwrap();
    let canon = std::fs::canonicalize(&repo).unwrap();
    assert_eq!(validate_remote(repo.to_str().unwrap(), &r).unwrap().url, canon.to_string_lossy());
    assert_eq!(validate_remote("~/Repos/notes.git", &r).unwrap().url, canon.to_string_lossy());
    let v = validate_remote(&format!("file://{}", repo.display()), &r).unwrap();
    assert_eq!((v.kind, v.url), ("file", canon.to_string_lossy().to_string()));
    // Not there yet is fine for validation (Test connection says "not found").
    assert!(validate_remote("~/Repos/later.git", &r).is_ok());
}

#[test]
fn refuses_what_could_run_programs_or_store_secrets() {
    let h = FakeHome::new();
    let r = roots(h.path());
    assert!(err_of(validate_remote("ext::sh -c touch% /tmp/pwned", &r)).contains("run a program"));
    assert!(err_of(validate_remote("fd::17", &r)).contains("run a program"));
    assert!(err_of(validate_remote("-uhelp", &r)).contains("“-”"));
    assert!(err_of(validate_remote("--upload-pack=touch /tmp/x", &r)).contains("“-”"));
    assert!(err_of(validate_remote("https://example.com/a\n.git", &r)).contains("control character"));
    assert!(err_of(validate_remote("https://me:hunter2@github.com/me/notes.git", &r)).contains("password or token"));
    assert!(err_of(validate_remote("ssh://me:pw@host/notes.git", &r)).contains("password or token"));
    assert!(validate_remote("https://me@github.com/me/notes.git", &r).is_ok(), "a user name alone is fine");
    assert!(err_of(validate_remote("git://example.com/notes.git", &r)).contains("can't receive pushes"));
    assert!(err_of(validate_remote("ftp://example.com/notes.git", &r)).contains("not a supported"));
    assert!(err_of(validate_remote("https://github.com", &r)).contains("path"));
    assert!(err_of(validate_remote("ssh://-oProxyCommand=x/notes.git", &r)).contains("server name"));
    assert!(err_of(validate_remote("-oProxyCommand=x:notes.git", &r)).contains("“-”"));
    assert!(err_of(validate_remote("https://exa mple.com/n.git", &r)).contains("spaces"));
    assert!(err_of(validate_remote("", &r)).contains("Enter the address"));
    assert!(err_of(validate_remote("notes.git", &r)).contains("full folder path"));
}

#[test]
fn local_folders_must_be_in_home_unless_picked() {
    let h = FakeHome::new();
    let r = roots(h.path());
    assert!(err_of(validate_remote("/etc/notes.git", &r)).contains("outside your home folder"));
    assert!(err_of(validate_remote("~/.ssh/notes.git", &r)).contains("hidden"));
    assert!(err_of(validate_remote("~/.minotes", &r)).contains("hidden"));
    assert!(err_of(validate_remote("~", &r)).contains("outside your home folder"), "the home folder itself");
    assert!(err_of(validate_remote(&format!("{}/Repos/../../x", h.path().display()), &r)).contains(".."));
    let outside = tempfile::tempdir().unwrap();
    let repo = outside.path().join("shared.git");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(validate_remote(repo.to_str().unwrap(), &r).is_err());
    let picked = LocalRoots { homes: vec![h.path().to_path_buf()], picked: vec![repo.clone()] };
    assert!(validate_remote(repo.to_str().unwrap(), &picked).is_ok(), "chosen in the folder picker");
    // A link from home to outside it counts as outside.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), h.path().join("Link")).unwrap();
        assert!(validate_remote("~/Link/shared.git", &r).is_err());
    }
}

#[test]
fn classifies_failures() {
    let c = |s: &str| classify_remote_failure(s).0;
    assert_eq!(c("git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository."), "auth");
    assert_eq!(c("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), "auth");
    assert_eq!(c("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/x.git/'"), "auth");
    assert_eq!(c("Host key verification failed.\r\nfatal: Could not read from remote repository."), "auth");
    assert!(classify_remote_failure("Host key verification failed.").1.contains("host key"));
    assert_eq!(c("remote: Repository not found.\nfatal: repository 'https://github.com/me/nope.git/' not found"), "not_found");
    assert_eq!(c("fatal: '/home/me/nope.git' does not appear to be a git repository\nfatal: Could not read from remote repository."), "not_found");
    assert_eq!(c("fatal: https://example.com/info/refs not valid: is this a git repository?"), "not_a_repo");
    assert_eq!(c("fatal: unable to access 'https://nope.invalid/x.git/': Could not resolve host: nope.invalid"), "offline");
    assert_eq!(c("ssh: connect to host 10.0.0.9 port 22: Connection refused"), "offline");
    assert_eq!(c("Git error: git ls-remote timed out after 20s"), "timeout");
    assert_eq!(classify_remote_failure("fatal: something odd\nmore").1, "something odd");
}

#[test]
fn test_connection_on_real_repositories() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let r = roots(h.path());
    let empty = bare(&h.path().join("Repos/empty.git"));
    let c = check_remote(empty.to_str().unwrap(), &r, REMOTE_TEST_TIMEOUT);
    assert_eq!(c.status, "empty", "{c:?}");
    assert!(c.usable());

    // A bare repo with a commit on main.
    let work = h.path().join("work");
    git_cmd::init_repo(&work).unwrap();
    git_cmd::tests::configure_test_repo(&work);
    std::fs::write(work.join("a.md"), "x").unwrap();
    git_cmd::commit_all(&work, "sync: laptop @ 2026-10-21T10:00:00+00:00").unwrap();
    git_cmd::set_remote_url(&work, empty.to_str().unwrap()).unwrap();
    git_cmd::push(&work).unwrap();
    let c = check_remote("~/Repos/empty.git", &r, REMOTE_TEST_TIMEOUT);
    assert_eq!((c.status, c.branches.clone(), c.default_branch.clone()), ("reachable", vec!["main".to_string()], Some("main".to_string())), "{c:?}");
    assert!(c.warning.is_none());

    let c = check_remote("~/Repos/missing.git", &r, REMOTE_TEST_TIMEOUT);
    assert_eq!(c.status, "not_found", "{c:?}");
    std::fs::create_dir_all(h.path().join("Repos/plain")).unwrap();
    assert_eq!(check_remote("~/Repos/plain", &r, REMOTE_TEST_TIMEOUT).status, "not_a_repo");
    std::fs::write(h.path().join("Repos/file.txt"), "x").unwrap();
    assert_eq!(check_remote("~/Repos/file.txt", &r, REMOTE_TEST_TIMEOUT).status, "not_a_repo");
    let c = check_remote(work.to_str().unwrap(), &r, REMOTE_TEST_TIMEOUT);
    assert_eq!(c.status, "reachable");
    assert!(c.warning.as_deref().unwrap_or("").contains("bare"), "a working folder: {c:?}");
    assert_eq!(check_remote("ext::sh -c id", &r, REMOTE_TEST_TIMEOUT).status, "invalid");
    // The watchdog's own message is "timeout".
    let c = check_remote("~/Repos/empty.git", &r, Duration::ZERO);
    assert!(matches!(c.status, "timeout" | "reachable"), "{c:?}");
}

/// A folder notebook in the fake home with one page.
fn notebook_with_page(home: &Path, name: &str, title: &str, text: &str) -> (crate::notebook::Notebook, Database, Uuid) {
    let nb = crate::notebook::create_in_folder(&home.join("MiNotes").join(name), name).unwrap();
    let db = nb.open_db().unwrap();
    let p = db.create_page(title, None, false, None, "user").unwrap();
    db.create_block(&p.id, text, None, None, "user").unwrap();
    (nb, db, p.id)
}

#[test]
fn set_up_change_and_remove_the_remote() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let r = roots(h.path());
    let (nb, db, _) = notebook_with_page(h.path(), "Work", "Roadmap", "ship it");
    let one = bare(&h.path().join("Repos/one.git"));

    // A bad address changes nothing.
    let e = sync_manager::setup_sync_with(&nb.key, "~/Repos/none.git", &r, || Ok::<_, Error>(&db)).unwrap_err();
    assert!(user_message(&e).starts_with("Not found"), "{e}");
    let st = sync_manager::get_sync_status(&nb.key).unwrap();
    assert!(!st.enabled && st.remote_url.is_none());
    assert!(!git_cmd::is_git_repo(&nb.mirror_dir()) || !git_cmd::has_remote(&nb.mirror_dir()));
    // The notebook's own folder is refused.
    assert!(sync_manager::setup_sync_with(&nb.key, nb.mirror_dir().to_str().unwrap(), &r, || Ok::<_, Error>(&db)).is_err());

    let st = sync_manager::setup_sync_with(&nb.key, "~/Repos/one.git", &r, || Ok::<_, Error>(&db)).unwrap();
    assert!(st.enabled);
    assert_eq!(st.remote_url.as_deref(), Some(std::fs::canonicalize(&one).unwrap().to_str().unwrap()));
    assert!(st.last_sync.is_some(), "the first push reached the remote: {st:?}");
    assert!(st.last_error.is_none());
    let (files, _, _) = git_cmd::run_git(&one, &["ls-tree", "-r", "--name-only", "main"]).unwrap();
    assert!(files.lines().any(|f| f == "Roadmap.md"), "{files}");
    assert!(sync_manager::setup_sync_with(&nb.key, "~/Repos/one.git", &r, || Ok::<_, Error>(&db)).is_err(), "already has one");

    // Change it: tested first; "Last synced" starts over; the next sync pushes there.
    assert!(sync_manager::change_remote(&nb.key, "~/Repos/two.git", &r).is_err(), "not there yet");
    let two = bare(&h.path().join("Repos/two.git"));
    let st = sync_manager::change_remote(&nb.key, two.to_str().unwrap(), &r).unwrap();
    assert!(st.last_sync.is_none() && st.remote_url.unwrap().ends_with("two.git"));
    let res = sync_manager::full_sync_with(&nb.key, || Ok::<_, Error>(&db)).unwrap();
    assert!(res.success, "{res:?}");
    let (files, _, _) = git_cmd::run_git(&two, &["ls-tree", "-r", "--name-only", "main"]).unwrap();
    assert!(files.lines().any(|f| f == "Roadmap.md"), "{files}");

    // Remove it: sync stays on, local only.
    let st = sync_manager::remove_sync_remote(&nb.key).unwrap();
    assert!(st.enabled && st.remote_url.is_none() && st.last_sync.is_none());
    let res = sync_manager::full_sync_with(&nb.key, || Ok::<_, Error>(&db)).unwrap();
    assert!(res.success && res.no_remote, "{res:?}");
}

#[test]
fn join_an_existing_plain_notebook() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let r = roots(h.path());
    let (nb, db, page) = notebook_with_page(h.path(), "Home", "Groceries", "milk");
    let remote = bare(&h.path().join("Repos/home.git"));

    // Nothing to join in an empty repository.
    let e = join_plain("~/Repos/home.git", &r, &h.path().join("MiNotes/Joined"), "Joined").unwrap_err();
    assert!(user_message(&e).contains("empty"), "{e}");
    assert!(!h.path().join("MiNotes/Joined").exists(), "a failed join creates nothing");

    sync_manager::setup_sync_with(&nb.key, remote.to_str().unwrap(), &r, || Ok::<_, Error>(&db)).unwrap();
    let joined = join_plain("~/Repos/home.git", &r, &h.path().join("MiNotes/Joined"), "Joined").unwrap();
    assert!(git_cmd::is_git_repo(&joined.mirror_dir()));
    let jdb = joined.open_db().unwrap();
    let st = sync_manager::enable_sync_with(&joined.key, || Ok::<_, Error>(&jdb)).unwrap();
    assert!(st.enabled && st.last_error.is_none(), "{st:?}");
    assert!(sync_manager::sync_trusted(&joined.key), "set up here: no “Sync it here” question");
    let p = jdb.get_page(&page).unwrap().expect("the page arrived with its id");
    assert_eq!(p.title, "Groceries");
    assert_eq!(jdb.get_page_blocks(&page).unwrap()[0].content, "milk");

    // The folder must be new.
    assert!(join_plain("~/Repos/home.git", &r, &h.path().join("MiNotes/Joined"), "Joined 2").is_err());
}

#[test]
fn joining_an_encrypted_remote_asks_for_the_passphrase() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let r = roots(h.path());
    let remote = bare(&h.path().join("Repos/vault.git"));
    let (nb, _) = crate::encryption::create_in_folder_with(
        &h.path().join("MiNotes/Vault"),
        "Vault",
        crate::encryption::tests::PASS,
        crate::encryption::tests::FAST,
    )
    .unwrap();
    let db = nb.open_db().unwrap();
    db.create_page("Secret plan", None, false, None, "user").unwrap();
    let st = sync_manager::setup_sync_with(&nb.key, remote.to_str().unwrap(), &r, || Ok::<_, Error>(&db)).unwrap();
    assert!(st.enabled && st.last_error.is_none(), "{st:?}");
    let e = join_plain(remote.to_str().unwrap(), &r, &h.path().join("MiNotes/Vault 2"), "Vault 2").unwrap_err();
    assert!(user_message(&e).starts_with(ENCRYPTED_REMOTE), "{e}");
    assert!(!h.path().join("MiNotes/Vault 2").exists());
}
