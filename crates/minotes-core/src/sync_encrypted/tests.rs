//! Two devices over a local bare remote, both with the same encrypted notebook
//! (device B joins with the passphrase). Nothing in either working tree, either
//! `.git`, or the remote may contain note content.

use std::path::{Path, PathBuf};

use super::*;
use crate::encryption::tests::{FAST, PASS};
use crate::notebook::tests::FakeHome;
use crate::notebook::Notebook;

struct Dev {
    nb: Notebook,
    db: Database,
}

impl Dev {
    fn dir(&self) -> PathBuf {
        self.nb.mirror_dir()
    }
    fn sync(&self, enabling: bool) -> sync_manager::GitSyncResult {
        cycle(&self.dir(), &|| Ok::<_, Error>(&self.db), enabling).unwrap()
    }
    fn page(&self, title: &str) -> crate::models::Page {
        self.db.get_page_by_title(title).unwrap().unwrap_or_else(|| panic!("no page {title}"))
    }
    fn texts(&self, title: &str) -> Vec<String> {
        self.db.get_page_blocks(&self.page(title).id).unwrap().into_iter().map(|b| b.content).collect()
    }
    fn titles(&self) -> Vec<String> {
        let mut t: Vec<String> = self.db.list_pages(Some(1000)).unwrap().into_iter().map(|p| p.title).collect();
        t.sort();
        t
    }
}

fn bare_remote(home: &Path) -> PathBuf {
    let remote = home.join("remote.git");
    std::fs::create_dir_all(&remote).unwrap();
    let (_, e, ok) = git_cmd::run_git(&remote, &["init", "--bare", "-q", "-b", "main"]).unwrap();
    assert!(ok, "{e}");
    remote
}

/// Device A: an encrypted notebook whose sync folder has the remote configured.
fn device_a(home: &Path, remote: &Path) -> Dev {
    let (nb, _) = crate::encryption::create_in_folder_with(&home.join("MiNotes/Vault"), "Vault", PASS, FAST).unwrap();
    let dir = nb.mirror_dir();
    git_cmd::init_repo(&dir).unwrap();
    let (_, e, ok) = git_cmd::run_git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
    assert!(ok, "{e}");
    let db = nb.open_db().unwrap();
    Dev { nb, db }
}

/// Device B joins the remote's notebook with the passphrase.
fn device_b(home: &Path, remote: &Path) -> Dev {
    let nb = join_from_remote(remote.to_str().unwrap(), &home.join("MiNotes/Vault on B"), "Vault on B", PASS).unwrap();
    let db = nb.open_db().unwrap();
    Dev { nb, db }
}

fn remote_head(remote: &Path) -> Option<String> {
    let (o, _, ok) = git_cmd::run_git(remote, &["rev-parse", "-q", "--verify", "refs/heads/main"]).unwrap();
    ok.then(|| o.trim().to_string())
}

/// Every byte git keeps: working tree files and every object, decompressed.
fn scan(repo: &Path) -> Vec<(String, Vec<u8>)> {
    let mut blobs: Vec<(String, Vec<u8>)> = Vec::new();
    fn walk(p: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
            let path = e.path();
            if path.is_dir() {
                walk(&path, out);
            } else if let Ok(b) = std::fs::read(&path) {
                out.push((path.display().to_string(), b));
            }
        }
    }
    walk(repo, &mut blobs);
    let (objects, _, ok) = git_cmd::run_git(repo, &["cat-file", "--batch-all-objects", "--batch"]).unwrap();
    assert!(ok);
    blobs.push((format!("{} (all git objects)", repo.display()), objects.into_bytes()));
    blobs
}

fn found(repo: &Path, needle: &str) -> bool {
    scan(repo).iter().any(|(_, b)| b.windows(needle.len()).any(|w| w == needle.as_bytes()))
}

/// None of the markers anywhere git keeps data.
fn assert_no_plaintext(repo: &Path, markers: &[&str]) {
    for (name, bytes) in &scan(repo) {
        for m in markers {
            assert!(!bytes.windows(m.len()).any(|w| w == m.as_bytes()), "{name} contains {m}");
        }
    }
}

const MARKERS: [&str; 6] = ["Ocelot title", "ocelot block", "OcelotFolder", "ocelotprop", "ocelot board", "OCELOT ATTACH"];

#[test]
fn two_devices_sync_everything_and_git_holds_no_plaintext() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let remote = bare_remote(h.path());
    let a = device_a(h.path(), &remote);
    let f = a.db.create_folder("OcelotFolder", None, None, None, "user").unwrap();
    let p = a.db.create_page("Ocelot title", None, false, None, "user").unwrap();
    a.db.move_page_to_folder(&p.id, Some(&f.id), "user").unwrap();
    let b1 = a.db.create_block(&p.id, "ocelot block one", None, None, "user").unwrap();
    a.db.create_block(&p.id, "child of one", Some(&b1.id), None, "user").unwrap();
    a.db.set_property(&b1.id, "block", "status", "ocelotprop", "text", "user").unwrap();
    a.db.save_whiteboard("wb1", r#"{"notes":[{"text":"ocelot board"}]}"#).unwrap();
    a.db.create_block(&p.id, "{{whiteboard:wb1}}", None, None, "user").unwrap();
    let att = a.db.store_attachment_bytes("n.txt", Some("text/plain"), b"OCELOT ATTACH bytes").unwrap().attachment;
    a.db.create_block(&p.id, &att.markdown(), None, None, "user").unwrap();
    let r = a.sync(true);
    assert!(r.success, "{r:?}");
    assert!(remote_head(&remote).is_some(), "A pushed");

    // A file per entity, opaque names, nothing readable.
    let files: Vec<String> = std::fs::read_dir(a.dir().join(PAGES)).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    assert!(files.iter().all(|f| f.len() == 32 + 4 && f.ends_with(".mne")), "{files:?}");

    let b = device_b(h.path(), &remote);
    let r = b.sync(true);
    assert!(r.success, "{r:?}");
    assert_eq!(b.texts("Ocelot title")[..2], ["ocelot block one".to_string(), "child of one".to_string()]);
    let bp = b.page("Ocelot title");
    assert_eq!(bp.folder_id, Some(f.id), "folder kept by id");
    assert_eq!(b.db.get_folder(&f.id).unwrap().unwrap().name, "OcelotFolder");
    let blocks = b.db.get_page_blocks(&bp.id).unwrap();
    let one = blocks.iter().find(|x| x.content == "ocelot block one").unwrap();
    assert_eq!(one.parent_id, None);
    assert!(blocks.iter().any(|x| x.parent_id == Some(one.id)), "nesting kept");
    let props = b.db.get_properties(&one.id).unwrap();
    assert!(props.iter().any(|p| p.key == "status" && p.value.as_deref() == Some("ocelotprop")), "F-7 block property synced: {props:?}");
    assert!(b.db.get_whiteboard("wb1").unwrap().unwrap().data.contains("ocelot board"));
    assert_eq!(b.db.attachment_bytes(&att.hash).unwrap().unwrap(), b"OCELOT ATTACH bytes");

    // Syncing again changes nothing and commits nothing.
    let head = remote_head(&remote);
    assert!(a.sync(false).success && b.sync(false).success);
    assert_eq!(remote_head(&remote), head, "no churn: unchanged pages are not re-encrypted");

    for repo in [a.dir(), b.dir(), remote.clone()] {
        assert_no_plaintext(&repo, &MARKERS);
        // Control: the scan does see inside git objects (the key file is plain JSON).
        assert!(found(&repo, "key_check"), "{} scan sees nothing", repo.display());
    }
}

#[test]
fn edits_to_different_blocks_merge_per_block_and_same_block_keeps_both() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let remote = bare_remote(h.path());
    let a = device_a(h.path(), &remote);
    let p = a.db.create_page("Plan", None, false, None, "user").unwrap();
    let x = a.db.create_block(&p.id, "line one", None, None, "user").unwrap();
    let y = a.db.create_block(&p.id, "line two", None, None, "user").unwrap();
    assert!(a.sync(true).success);
    let b = device_b(h.path(), &remote);
    assert!(b.sync(true).success);

    // Different blocks: both edits survive on both devices, no conflict page.
    a.db.update_block(&x.id, Some("line one — edited on A"), "user").unwrap();
    b.db.update_block(&y.id, Some("line two — edited on B"), "user").unwrap();
    assert!(a.sync(false).success);
    let r = b.sync(false);
    assert!(r.success, "{r:?}");
    assert_eq!(r.conflicts_resolved, 1, "git conflicted on the page file");
    assert_eq!(b.texts("Plan"), ["line one — edited on A", "line two — edited on B"]);
    assert!(b.sync(false).success); // pushes the merge
    assert!(a.sync(false).success);
    assert_eq!(a.texts("Plan"), ["line one — edited on A", "line two — edited on B"]);
    assert!(!a.titles().iter().chain(b.titles().iter()).any(|t| t.contains("conflict")), "{:?}", b.titles());

    // The same block: the other version is kept as a conflict page (nothing lost).
    a.db.update_block(&x.id, Some("one by A"), "user").unwrap();
    b.db.update_block(&x.id, Some("one by B"), "user").unwrap();
    assert!(a.sync(false).success);
    assert!(b.sync(false).success);
    let all: Vec<String> = b
        .db
        .list_pages(Some(1000))
        .unwrap()
        .iter()
        .flat_map(|p| b.db.get_page_blocks(&p.id).unwrap().into_iter().map(|bl| bl.content))
        .collect();
    assert!(all.contains(&"one by A".to_string()) && all.contains(&"one by B".to_string()), "{all:?}");
    assert!(b.titles().iter().any(|t| t.contains("conflict")), "{:?}", b.titles());
    for repo in [a.dir(), b.dir(), remote.clone()] {
        assert_no_plaintext(&repo, &["line one", "line two", "one by"]);
    }
}

#[test]
fn deleting_a_page_moves_it_to_the_other_devices_trash() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let remote = bare_remote(h.path());
    let a = device_a(h.path(), &remote);
    let keep = a.db.create_page("Keep", None, false, None, "user").unwrap();
    a.db.create_block(&keep.id, "k", None, None, "user").unwrap();
    let gone = a.db.create_page("Gone", None, false, None, "user").unwrap();
    a.db.create_block(&gone.id, "g", None, None, "user").unwrap();
    assert!(a.sync(true).success);
    let b = device_b(h.path(), &remote);
    assert!(b.sync(true).success);
    assert!(b.titles().contains(&"Gone".to_string()));
    a.db.trash_page(&gone.id).unwrap();
    assert!(a.sync(false).success);
    assert!(b.sync(false).success);
    assert!(b.db.is_trashed(&gone.id).unwrap(), "trashed on B, not hard-deleted");
    assert!(!b.db.is_trashed(&keep.id).unwrap());
}

#[test]
fn a_remote_of_another_notebook_or_a_plain_one_fails_closed() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let remote = bare_remote(h.path());
    let a = device_a(h.path(), &remote);
    a.db.create_page("A's page", None, false, None, "user").unwrap();
    assert!(a.sync(true).success);
    let before = remote_head(&remote);

    // Device C: its own encrypted notebook — same passphrase, different key.
    let (nb, _) = crate::encryption::create_in_folder_with(&h.path().join("MiNotes/Other"), "Other", PASS, FAST).unwrap();
    let dir = nb.mirror_dir();
    git_cmd::init_repo(&dir).unwrap();
    git_cmd::run_git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
    let c = Dev { db: nb.open_db().unwrap(), nb };
    c.db.create_page("C's page", None, false, None, "user").unwrap();
    let e = cycle(&c.dir(), &|| Ok::<_, Error>(&c.db), true).err().expect("refused");
    assert!(e.to_string().contains("different encrypted notebook"), "{e}");
    assert_eq!(remote_head(&remote), before, "the remote is untouched");
    assert!(git_cmd::rev_parse_head(&c.dir()).unwrap().is_none(), "C committed nothing");
    assert!(c.db.get_page_by_title("A's page").unwrap().is_none(), "nothing imported");
    // A later regular sync on C is refused the same way.
    let r = c.sync(false);
    assert!(!r.success && r.error.unwrap().contains("different encrypted notebook"));
    assert_eq!(remote_head(&remote), before);

    // A plain (markdown) remote is refused too.
    let plain = h.path().join("plain.git");
    std::fs::create_dir_all(&plain).unwrap();
    git_cmd::run_git(&plain, &["init", "--bare", "-q", "-b", "main"]).unwrap();
    let w = h.path().join("plain-work");
    git_cmd::init_repo(&w).unwrap();
    std::fs::write(w.join("Note.md"), "---\ntitle: Note\n---\n- hello\n").unwrap();
    git_cmd::commit_all(&w, "plain").unwrap();
    git_cmd::run_git(&w, &["remote", "add", "origin", plain.to_str().unwrap()]).unwrap();
    git_cmd::push(&w).unwrap();
    git_cmd::run_git(&a.dir(), &["remote", "set-url", "origin", plain.to_str().unwrap()]).unwrap();
    let r = a.sync(false);
    assert!(!r.success && r.error.as_deref().unwrap_or("").contains("not this encrypted notebook"), "{r:?}");
    assert_eq!(remote_head(&plain).is_some(), true);
}

#[test]
fn joining_with_a_wrong_passphrase_creates_nothing() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let remote = bare_remote(h.path());
    let a = device_a(h.path(), &remote);
    assert!(a.sync(true).success);
    let before = remote_head(&remote);
    let root = h.path().join("MiNotes/Intruder");
    let e = join_from_remote(remote.to_str().unwrap(), &root, "Intruder", "not the passphrase at all").err().unwrap();
    assert!(matches!(e, Error::WrongPassphrase), "{e:?}");
    assert!(!root.exists(), "no notebook folder");
    assert!(!crate::notebook::list().iter().any(|n| n.name == "Intruder"));
    assert_eq!(remote_head(&remote), before);
}
