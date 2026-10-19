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

/// The remote's key file (at the tip of main).
fn remote_key_file(remote: &Path) -> KeyFile {
    let (text, e, ok) = git_cmd::run_git(remote, &["show", &format!("main:{KEY_FILE}")]).unwrap();
    assert!(ok, "{e}");
    read_key_file_text(&text).unwrap()
}

const NEW_PASS: &str = "a brand new passphrase, longer";

// Opportunity P2 (E17): a passphrase change (or a new recovery key) reaches the
// sync repo's key file, so a device joining later uses the CURRENT passphrase;
// a device that is already syncing keeps working (same data key) and never
// writes its older slots back.
#[test]
fn a_passphrase_change_reaches_the_sync_repo_and_devices_keep_syncing() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let remote = bare_remote(h.path());
    let a = device_a(h.path(), &remote);
    let p = a.db.create_page("Plan", None, false, None, "user").unwrap();
    a.db.create_block(&p.id, "line one", None, None, "user").unwrap();
    assert!(a.sync(true).success);
    let b = device_b(h.path(), &remote);
    assert!(b.sync(true).success);

    crate::encryption::change_passphrase_with(&a.nb, crate::crypto::Secret::Passphrase(PASS), NEW_PASS, FAST).unwrap();
    let r = a.sync(false);
    assert!(r.success, "{r:?}");
    let slots_a = crate::notebook::read_meta(a.nb.root().unwrap()).unwrap().encryption.unwrap();
    assert_eq!(remote_key_file(&remote).encryption, slots_a, "the new slots are published");

    // B (old slots locally) keeps syncing both ways and doesn't revert the key file.
    b.db.create_block(&p.id, "from B", None, None, "user").unwrap();
    let r = b.sync(false);
    assert!(r.success, "{r:?}");
    assert!(b.sync(false).success);
    assert_eq!(remote_key_file(&remote).encryption, slots_a, "B never writes its older slots back");
    assert!(a.sync(false).success);
    assert!(a.texts("Plan").contains(&"from B".to_string()));

    // A device joining now: the old passphrase fails, the new one works.
    let old = join_from_remote(remote.to_str().unwrap(), &h.path().join("MiNotes/Late"), "Late", PASS).err().expect("old refused");
    assert!(matches!(old, Error::WrongPassphrase), "{old:?}");
    let nb = join_from_remote(remote.to_str().unwrap(), &h.path().join("MiNotes/Late2"), "Late2", NEW_PASS).unwrap();
    let late = Dev { db: nb.open_db().unwrap(), nb };
    assert!(late.sync(true).success);
    assert_eq!(late.texts("Plan"), ["line one", "from B"]);

    // A new recovery key is published the same way (the old one stops joining).
    let rk_old_slots = remote_key_file(&remote).encryption;
    let rk = crate::encryption::regenerate_recovery_key(&a.nb, NEW_PASS).unwrap();
    assert!(a.sync(false).success);
    assert_ne!(remote_key_file(&remote).encryption, rk_old_slots);
    let nb = join_from_remote(remote.to_str().unwrap(), &h.path().join("MiNotes/ByRecovery"), "ByRecovery", &rk.display()).unwrap();
    assert!(nb.open_db().is_ok());
    for repo in [a.dir(), b.dir(), remote.clone()] {
        assert_no_plaintext(&repo, &["line one", "from B", "Plan"]);
    }
}

// Rotating the data key re-encrypts the sync repo (edits another device pushed
// before the rotation are pulled with the old key first, not lost); a device
// still on the old key fails closed with "the key was changed" and leaves the
// remote untouched; a device joining afterwards gets everything.
#[test]
fn a_key_rotation_reencrypts_the_repo_and_old_key_devices_fail_closed() {
    if !git_cmd::git_available() {
        return;
    }
    let h = FakeHome::new();
    let remote = bare_remote(h.path());
    let a = device_a(h.path(), &remote);
    let p = a.db.create_page("Plan", None, false, None, "user").unwrap();
    a.db.create_block(&p.id, "line one", None, None, "user").unwrap();
    assert!(a.sync(true).success);
    let b = device_b(h.path(), &remote);
    assert!(b.sync(true).success);
    let old_check = remote_key_file(&remote).key_check;
    b.db.create_block(&p.id, "pushed by B before the rotation", None, None, "user").unwrap();
    assert!(b.sync(false).success);

    // A rotates (its database must be closed for the conversion).
    let Dev { nb, db } = a;
    drop(db);
    crate::encryption::rotate_key_with(&nb, PASS, FAST, &mut |_| Ok(())).unwrap();
    let a = Dev { db: nb.open_db().unwrap(), nb };
    let r = a.sync(false);
    assert!(r.success, "{r:?}");
    assert!(a.texts("Plan").contains(&"pushed by B before the rotation".to_string()), "B's edit was pulled first");
    let kf = remote_key_file(&remote);
    assert_ne!(kf.key_check, old_check);
    assert_eq!(kf.key_check, SyncKeys::new(&a.db.data_key().unwrap()).key_check());
    assert_eq!(kf.generation, 2);
    assert_eq!(kf.previous_key_checks, vec![old_check.clone()]);
    // Every file is under the new key: none of the old names is left.
    let (files, _, _) = git_cmd::run_git(&remote, &["ls-tree", "-r", "--name-only", "main"]).unwrap();
    let keys_a = SyncKeys::new(&a.db.data_key().unwrap());
    for f in files.lines().filter(|f| f.ends_with(".mne")) {
        let (text, _, ok) = git_cmd::run_git(&remote, &["show", &format!("main:{f}")]).unwrap();
        assert!(ok && decode_entry(&keys_a, f, &text).is_ok(), "{f} is not under the new key");
    }
    assert!(a.sync(false).success, "A keeps syncing");

    // B, still on the old key: refused, nothing pulled or pushed.
    let before = remote_head(&remote);
    b.db.create_block(&p.id, "B after the rotation", None, None, "user").unwrap();
    let r = b.sync(false);
    assert!(!r.success);
    let msg = r.error.unwrap_or_default();
    assert!(msg.contains("changed (rotated) on another device"), "{msg}");
    assert_eq!(remote_head(&remote), before, "the remote is untouched");
    assert!(!b.texts("Plan").is_empty(), "B's notes are unchanged");

    // A new device joins with the passphrase: everything, under the new key.
    let nb = join_from_remote(remote.to_str().unwrap(), &h.path().join("MiNotes/After"), "After", PASS).unwrap();
    let c = Dev { db: nb.open_db().unwrap(), nb };
    assert!(c.sync(true).success);
    assert_eq!(c.texts("Plan"), ["line one", "pushed by B before the rotation"]);
    for repo in [a.dir(), b.dir(), c.dir(), remote.clone()] {
        assert_no_plaintext(&repo, &["line one", "pushed by B", "B after the rotation"]);
    }
}

fn today_journals(d: &Dev) -> Vec<crate::models::Page> {
    let date = chrono::NaiveDate::from_ymd_opt(2026, 10, 15).unwrap();
    d.db.list_pages(Some(1000)).unwrap().into_iter().filter(|p| p.is_journal && p.journal_date == Some(date)).collect()
}

/// Today's journal as the app shows it (the page with the day's title).
fn shown_journal(d: &Dev) -> crate::models::Page {
    d.db.find_journal(chrono::NaiveDate::from_ymd_opt(2026, 10, 15).unwrap()).unwrap().expect("today's journal")
}

// Nightly D14 failure (2026-10-15): both devices create today's journal on their
// own (random ids, same title). Sync used to keep both, as "Journal/…" and
// "Journal/… (2)", and which page got the suffix depended on the order the
// files were imported — the devices could disagree, and then each one's export
// rewrote the other's journal title at every sync. Once both devices touched
// the same journal file in one round, the per-block merge saw the title change
// as a conflict and kept a "(conflict from …)" page although no block
// conflicted. The disagreement is forced here with the order that always makes
// it (each device imports the other's journal before seeing its rename), then
// D14's different-block edits run with A's startup sync before or after its edit
// (no git conflict on the page / a git conflict on it).
fn journals_of_one_day(startup_sync_first: bool) {
    let date = chrono::NaiveDate::from_ymd_opt(2026, 10, 15).unwrap();
    let h = FakeHome::new();
    let remote = bare_remote(h.path());
    let a = device_a(h.path(), &remote);
    let ja = a.db.get_or_create_journal(date, None, "user").unwrap();
    a.db.create_block(&ja.id, "jotted on A", None, None, "user").unwrap();
    let p = a.db.create_page("Lynx", None, false, None, "user").unwrap();
    let x = a.db.create_block(&p.id, "first line", None, None, "user").unwrap();
    let y = a.db.create_block(&p.id, "second line", None, None, "user").unwrap();
    assert!(a.sync(true).success);
    let b = device_b(h.path(), &remote);
    // B opens today's journal before its first sync: its own page.
    let jb = b.db.get_or_create_journal(date, None, "user").unwrap();
    b.db.create_block(&jb.id, "jotted on B", None, None, "user").unwrap();
    assert!(b.sync(true).success);
    assert!(a.sync(false).success);

    // B edits a block and syncs, then writes in today's journal; A edits another
    // block (before or after its startup sync) and syncs.
    b.db.update_block(&y.id, Some("second line — B"), "user").unwrap();
    assert!(b.sync(false).success);
    b.db.create_block(&shown_journal(&b).id, "later on B", None, None, "user").unwrap();
    if startup_sync_first {
        assert!(a.sync(false).success);
    }
    a.db.update_block(&x.id, Some("first line — A"), "user").unwrap();
    let r = a.sync(false);
    assert!(r.success, "{r:?}");
    assert_eq!(r.conflicts_resolved > 0, !startup_sync_first, "git conflicted on the page iff A edited before pulling");
    assert!(a.sync(false).success);
    for _ in 0..3 {
        assert!(b.sync(false).success);
        assert!(a.sync(false).success);
    }

    for d in [&a, &b] {
        assert_eq!(d.texts("Lynx"), ["first line — A", "second line — B"]);
        let titles = d.titles();
        assert!(!titles.iter().any(|t| t.contains("conflict")), "{titles:?}");
        let j = today_journals(d);
        assert_eq!(j.len(), 1, "one journal for the day: {titles:?}");
        assert_eq!(j[0].id, ja.id.min(jb.id), "the same page on both devices");
        assert_eq!(j[0].title, "Journal/2026-10-15");
        let texts: Vec<String> = d.db.get_page_blocks(&j[0].id).unwrap().into_iter().map(|b| b.content).collect();
        for t in ["jotted on A", "jotted on B", "later on B"] {
            assert!(texts.contains(&t.to_string()), "{t} missing: {texts:?}");
        }
    }
    // Stable: another round commits nothing.
    let head = remote_head(&remote);
    assert!(a.sync(false).success && b.sync(false).success && a.sync(false).success);
    assert_eq!(remote_head(&remote), head, "no title ping-pong");
}

#[test]
fn journals_of_one_day_merge_into_one_page_startup_sync_after_the_edit() {
    if git_cmd::git_available() {
        journals_of_one_day(false);
    }
}

#[test]
fn journals_of_one_day_merge_into_one_page_startup_sync_before_the_edit() {
    if git_cmd::git_available() {
        journals_of_one_day(true);
    }
}
