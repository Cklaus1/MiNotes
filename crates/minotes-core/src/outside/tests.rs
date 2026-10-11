use super::*;
use crate::mirror::{run, MirrorTarget};

fn setup() -> (tempfile::TempDir, Database, MirrorTarget) {
    let tmp = tempfile::tempdir().unwrap();
    let db = Database::open_in_memory().unwrap();
    let target = MirrorTarget::new(tmp.path().join("notes"), Some(tmp.path().join("state.json")));
    (tmp, db, target)
}

fn texts(db: &Database, page: &Uuid) -> Vec<String> {
    db.get_page_blocks(page).unwrap().into_iter().map(|b| b.content).collect()
}

fn ids(db: &Database, page: &Uuid) -> Vec<Uuid> {
    db.get_page_blocks(page).unwrap().into_iter().map(|b| b.id).collect()
}

fn read(target: &MirrorTarget, rel: &str) -> String {
    fs::read_to_string(target.dir.join(rel)).unwrap()
}

fn paths(rels: &[&str]) -> Scope {
    Scope::Paths(rels.iter().map(PathBuf::from).collect())
}

/// A page with three blocks, mirrored.
fn page_abc(db: &Database, target: &MirrorTarget) -> (Uuid, Vec<Uuid>) {
    let p = db.create_page("Plans", None, false, None, "user").unwrap();
    let a = db.create_block(&p.id, "alpha", None, None, "user").unwrap();
    let b = db.create_block(&p.id, "beta", None, None, "user").unwrap();
    let c = db.create_block(&p.id, "gamma", None, None, "user").unwrap();
    db.create_block(&p.id, "gamma child", Some(&c.id), None, "user").unwrap();
    run(db, target, false).unwrap();
    (p.id, vec![a.id, b.id, c.id])
}

#[test]
fn guard_never_overwrites_a_file_edited_outside() {
    let (_tmp, db, target) = setup();
    let (pid, blocks) = page_abc(&db, &target);
    let edited = read(&target, "Plans.md") + "- written in another editor\n";
    fs::write(target.dir.join("Plans.md"), &edited).unwrap();
    // The page changes in the app; an incremental pass (no import) must not clobber the file.
    db.update_block(&blocks[0], Some("alpha in app"), "user").unwrap();
    let r = mirror::apply(&target, mirror::prepare(&db, &target, false).unwrap()).unwrap();
    assert_eq!(r.guarded, vec!["Plans.md".to_string()]);
    assert_eq!(read(&target, "Plans.md"), edited, "incremental pass left the outside edit alone");
    // A full pass (startup / git sync) doesn't either.
    let r = mirror::apply(&target, mirror::prepare(&db, &target, true).unwrap()).unwrap();
    assert!(r.full);
    assert_eq!(r.guarded, vec!["Plans.md".to_string()]);
    assert_eq!(read(&target, "Plans.md"), edited, "full pass left the outside edit alone");
    // The record still says what the mirror wrote, so the edit is still detected.
    let st = mirror::load_state(target.state_path.as_ref().unwrap());
    assert_ne!(st.pages[&pid].hash, file_hash(&edited));
}

#[test]
fn outside_edit_is_imported_with_ids_kept_and_removed_lines_go_to_trash() {
    let (_tmp, db, target) = setup();
    let (pid, blocks) = page_abc(&db, &target);
    let child = db.get_page_blocks(&pid).unwrap().into_iter().find(|b| b.content == "gamma child").unwrap().id;
    let orig = read(&target, "Plans.md");
    // Change beta (marker kept), drop gamma (and its child), add a line.
    let edited: String = orig
        .lines()
        .filter(|l| !l.contains("gamma"))
        .map(|l| if l.contains("beta") { l.replace("beta", "beta, edited outside") } else { l.to_string() })
        .chain(std::iter::once("- delta from vim".to_string()))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(target.dir.join("Plans.md"), &edited).unwrap();

    let r = import_outside_edits(&db, &target, &paths(&["Plans.md"])).unwrap();
    assert_eq!(r.imported.len(), 1, "{r:?}");
    let imp = &r.imported[0];
    assert_eq!(imp.page_id, pid);
    assert_eq!((imp.blocks_created, imp.blocks_removed), (1, 2));
    assert_eq!(texts(&db, &pid), vec!["alpha", "beta, edited outside", "delta from vim"]);
    let now = ids(&db, &pid);
    assert_eq!(&now[..2], &blocks[..2], "ids kept");
    // gamma + child: not deleted — parked, with their ids, in a page in the Trash.
    let parked = imp.removed_page_id.expect("removed lines parked");
    assert!(db.is_trashed(&parked).unwrap());
    let parked_blocks = db.get_page_blocks(&parked).unwrap();
    assert_eq!(parked_blocks.iter().map(|b| b.id).collect::<Vec<_>>(), vec![blocks[2], child]);
    assert_eq!(parked_blocks[1].parent_id, Some(blocks[2]));
    assert!(db.get_page(&parked).unwrap().unwrap().title.starts_with("Plans (removed outside "));
    assert!(!db.list_pages(None).unwrap().iter().any(|p| p.id == parked && !db.is_trashed(&p.id).unwrap()));

    // The next pass writes the page back with a marker for the new block…
    let w = run(&db, &target, false).unwrap();
    assert!(w.outside.is_empty(), "nothing new outside: {:?}", w.outside);
    let text = read(&target, "Plans.md");
    assert!(text.contains(&format!("delta from vim <!-- id:{} -->", now[2])), "{text}");
    // …and that write is ours: nothing to import.
    assert!(import_outside_edits(&db, &target, &paths(&["Plans.md"])).unwrap().is_empty());
    assert!(import_outside_edits(&db, &target, &Scope::All).unwrap().is_empty());

    // One undo step brings the page back exactly; the parked page goes away.
    set_page_blocks(&db, &pid, &imp.before, None, imp.removed_page_id.as_ref()).unwrap();
    assert_eq!(texts(&db, &pid), vec!["alpha", "beta", "gamma", "gamma child"]);
    assert_eq!(ids(&db, &pid), vec![blocks[0], blocks[1], blocks[2], child]);
    assert!(db.get_page(&parked).unwrap().is_none(), "empty parking page removed");
    // Redo parks the removed lines again (never a hard delete).
    let again = set_page_blocks(&db, &pid, &imp.after, Some("Plans"), None).unwrap().unwrap();
    assert_eq!(texts(&db, &pid), vec!["alpha", "beta, edited outside", "delta from vim"]);
    assert!(db.is_trashed(&again).unwrap());
    assert_eq!(db.get_page_blocks(&again).unwrap().len(), 2);
}

#[test]
fn edit_on_both_sides_keeps_the_outside_version_as_a_separate_page() {
    let (_tmp, db, target) = setup();
    let (pid, blocks) = page_abc(&db, &target);
    let edited = read(&target, "Plans.md").replace("alpha", "alpha from outside");
    fs::write(target.dir.join("Plans.md"), &edited).unwrap();
    db.update_block(&blocks[0], Some("alpha from the app"), "user").unwrap();

    let r = run(&db, &target, false).unwrap(); // import first, then write
    let c = &r.outside.conflicts;
    assert_eq!(c.len(), 1, "{:?}", r.outside);
    assert_eq!(c[0].page_id, Some(pid));
    assert_eq!(c[0].copy_title, "Plans (edited outside)");
    assert_eq!(texts(&db, &pid)[0], "alpha from the app", "the app's version stays in the page");
    let copy = db.get_page_by_title("Plans (edited outside)").unwrap().unwrap();
    assert_eq!(texts(&db, &copy.id), vec!["alpha from outside", "beta", "gamma", "gamma child"]);
    assert!(ids(&db, &copy.id).iter().all(|i| !blocks.contains(i)), "the copy has its own block ids");
    // Both are in the mirror now, and nothing more is pending.
    assert!(read(&target, "Plans.md").contains("alpha from the app"));
    assert!(read(&target, "Plans (edited outside).md").contains("alpha from outside"));
    assert!(import_outside_edits(&db, &target, &Scope::All).unwrap().is_empty());
}

#[test]
fn new_files_become_pages_and_never_merge_into_a_same_titled_page() {
    let (_tmp, db, target) = setup();
    let (pid, _) = page_abc(&db, &target);
    fs::create_dir_all(target.dir.join("Inbox")).unwrap();
    fs::write(target.dir.join("Inbox/New Idea.md"), "- one\n  - nested\n- two\n").unwrap();
    // A hand-written file with a title that is taken.
    fs::create_dir_all(target.dir.join("Other")).unwrap();
    fs::write(target.dir.join("Other/Plans.md"), "- not the same page\n").unwrap();

    let r = import_outside_edits(&db, &target, &paths(&["Inbox/New Idea.md", "Other/Plans.md"])).unwrap();
    let mut created: Vec<&str> = r.created.iter().map(|p| p.title.as_str()).collect();
    created.sort();
    assert_eq!(created, vec!["New Idea", "Plans (2)"]);
    let idea = db.get_page_by_title("New Idea").unwrap().unwrap();
    assert_eq!(texts(&db, &idea.id), vec!["one", "nested", "two"]);
    let folder = db.get_folder(&idea.folder_id.unwrap()).unwrap().unwrap();
    assert_eq!(folder.name, "Inbox");
    assert_eq!(texts(&db, &pid), vec!["alpha", "beta", "gamma", "gamma child"], "same-titled page untouched");

    run(&db, &target, false).unwrap();
    let idea_md = read(&target, "Inbox/New Idea.md");
    assert!(idea_md.contains(&format!("id: {}", idea.id)), "file adopted in place: {idea_md}");
    assert!(target.dir.join("Other/Plans (2).md").exists());
    assert!(!target.dir.join("Other/Plans.md").exists(), "imported file moved aside (it lives on as Plans (2))");
    assert!(target.dir.join(".minotes-trash").is_dir());
    assert!(import_outside_edits(&db, &target, &Scope::All).unwrap().is_empty(), "settled");
}

#[test]
fn deleted_file_moves_its_page_to_trash() {
    let (_tmp, db, target) = setup();
    let (pid, _) = page_abc(&db, &target);
    db.create_page("Keep", None, false, None, "user").unwrap();
    run(&db, &target, false).unwrap();
    fs::remove_file(target.dir.join("Plans.md")).unwrap();
    let r = import_outside_edits(&db, &target, &paths(&["Plans.md"])).unwrap();
    assert_eq!(r.trashed.iter().map(|p| p.page_id).collect::<Vec<_>>(), vec![pid]);
    assert!(db.is_trashed(&pid).unwrap());
    assert_eq!(texts(&db, &pid).len(), 4, "trashed, not deleted");
    let w = run(&db, &target, false).unwrap();
    assert!(w.outside.is_empty());
    assert!(!target.dir.join("Plans.md").exists());
}

#[test]
fn deleting_many_files_at_once_is_refused_by_the_mass_delete_guard() {
    let (_tmp, db, target) = setup();
    for i in 0..10 {
        let p = db.create_page(&format!("Note {i}"), None, false, None, "user").unwrap();
        db.create_block(&p.id, "x", None, None, "user").unwrap();
    }
    run(&db, &target, false).unwrap();
    for i in 0..8 {
        fs::remove_file(target.dir.join(format!("Note {i}.md"))).unwrap();
    }
    let r = run(&db, &target, false).unwrap();
    assert_eq!(r.outside.kept.len(), 8);
    assert!(r.outside.trashed.is_empty());
    assert!(db.list_trash().unwrap().is_empty());
    for i in 0..10 {
        assert!(target.dir.join(format!("Note {i}.md")).exists(), "Note {i} written back");
    }
    // An edit beats a deletion: a file deleted after its page changed is written back.
    fs::remove_file(target.dir.join("Note 9.md")).unwrap();
    let p9 = db.get_page_by_title("Note 9").unwrap().unwrap();
    db.create_block(&p9.id, "edited here", None, None, "user").unwrap();
    let r = run(&db, &target, false).unwrap();
    assert_eq!(r.outside.restored.len(), 1);
    assert!(!db.is_trashed(&p9.id).unwrap());
    assert!(read(&target, "Note 9.md").contains("edited here"));
}

#[test]
fn unparseable_files_are_left_untouched_and_reported_once() {
    let (_tmp, db, target) = setup();
    let (pid, blocks) = page_abc(&db, &target);
    let binary: Vec<u8> = b"---\nid: x\n---\n- \x00\x01\x02 binary".to_vec();
    fs::write(target.dir.join("Plans.md"), &binary).unwrap();
    fs::write(target.dir.join("Garbage.md"), [0xff, 0xfe, 0x00, 0x41]).unwrap();
    fs::write(target.dir.join("Broken.md"), "---\ntitle: never closed\n- a\n").unwrap();
    db.update_block(&blocks[0], Some("changed in the app"), "user").unwrap();

    let r = run(&db, &target, false).unwrap();
    let mut rej: Vec<String> = r.outside.rejected.iter().map(|x| x.path.clone()).collect();
    rej.sort();
    assert_eq!(rej, vec!["Broken.md", "Garbage.md", "Plans.md"]);
    assert_eq!(fs::read(target.dir.join("Plans.md")).unwrap(), binary, "never rewritten");
    assert_eq!(fs::read(target.dir.join("Garbage.md")).unwrap(), vec![0xff, 0xfe, 0x00, 0x41]);
    assert_eq!(r.guarded, vec!["Plans.md".to_string()]);
    assert_eq!(texts(&db, &pid)[0], "changed in the app");
    assert!(db.get_page_by_title("Garbage").unwrap().is_none());
    // Reported once per version.
    let r = run(&db, &target, false).unwrap();
    assert!(r.outside.rejected.is_empty());
    assert_eq!(fs::read(target.dir.join("Plans.md")).unwrap(), binary);
}

#[test]
fn own_writes_and_private_paths_are_ignored() {
    let (_tmp, db, target) = setup();
    let (pid, blocks) = page_abc(&db, &target);
    let f = db.create_folder("Work", None, None, None, "user").unwrap();
    let w = db.create_page("Work Page", None, false, None, "user").unwrap();
    db.move_page_to_folder(&w.id, Some(&f.id), "user").unwrap();
    db.create_block(&w.id, "{{whiteboard:wb-x}}", None, None, "user").unwrap();
    db.save_whiteboard("wb-x", r#"{"s":1}"#).unwrap();
    for i in 0..3 {
        db.update_block(&blocks[0], Some(&format!("alpha {i}")), "user").unwrap();
        run(&db, &target, false).unwrap();
        run(&db, &target, true).unwrap();
    }
    let events_before: i64 = db.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
    let mut all: Vec<String> = Vec::new();
    for e in walk(&target.dir) {
        all.push(e);
    }
    assert!(all.iter().any(|p| p.ends_with(".minotes-folder.json")));
    let r = import_outside_edits(&db, &target, &Scope::Paths(all.iter().map(PathBuf::from).collect())).unwrap();
    assert!(r.is_empty(), "{r:?}");
    assert!(import_outside_edits(&db, &target, &Scope::All).unwrap().is_empty());
    // Private and temp paths are never looked at, even when they change.
    for rel in [".minotes-trash/x/Plans.md", ".git/HEAD.md", "_attachments/ab/c.md", ".Plans.md.swp", "Plans.md~"] {
        assert!(is_ignored(Path::new(rel)), "{rel}");
    }
    fs::create_dir_all(target.dir.join(".minotes-trash/x")).unwrap();
    fs::write(target.dir.join(".minotes-trash/x/Stray.md"), "- stray").unwrap();
    assert!(import_outside_edits(&db, &target, &Scope::All).unwrap().is_empty());
    let events_after: i64 = db.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
    assert_eq!(events_before, events_after, "nothing written to the database");
    assert_eq!(texts(&db, &pid)[0], "alpha 2");
}

fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(root.join(&d)).unwrap().flatten() {
            let rel = d.join(e.file_name());
            if e.file_type().unwrap().is_dir() {
                stack.push(rel.clone());
            }
            out.push(rel.to_string_lossy().to_string());
        }
    }
    out
}

#[test]
fn renaming_or_moving_a_file_renames_or_moves_the_page() {
    let (_tmp, db, target) = setup();
    let (pid, blocks) = page_abc(&db, &target);
    fs::rename(target.dir.join("Plans.md"), target.dir.join("Roadmap.md")).unwrap();
    let r = import_outside_edits(&db, &target, &paths(&["Plans.md", "Roadmap.md"])).unwrap();
    assert!(r.trashed.is_empty(), "a rename is not a deletion: {r:?}");
    assert_eq!(db.get_page(&pid).unwrap().unwrap().title, "Roadmap");
    assert_eq!(ids(&db, &pid)[..3], blocks[..]);
    run(&db, &target, false).unwrap();
    assert!(read(&target, "Roadmap.md").contains("title: \"Roadmap\""));
    assert!(!target.dir.join("Plans.md").exists());
    // Into a directory: the page moves to that folder.
    fs::create_dir_all(target.dir.join("Archive")).unwrap();
    fs::rename(target.dir.join("Roadmap.md"), target.dir.join("Archive/Roadmap.md")).unwrap();
    import_outside_edits(&db, &target, &paths(&["Roadmap.md", "Archive/Roadmap.md"])).unwrap();
    let p = db.get_page(&pid).unwrap().unwrap();
    assert_eq!(db.get_folder(&p.folder_id.unwrap()).unwrap().unwrap().name, "Archive");
    run(&db, &target, false).unwrap();
    assert!(import_outside_edits(&db, &target, &Scope::All).unwrap().is_empty());
    assert!(!db.is_trashed(&pid).unwrap());
}

#[test]
fn read_only_database_never_imports() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("nb.db");
    let target = MirrorTarget::new(tmp.path().join("notes"), Some(tmp.path().join("state.json")));
    let pid = {
        let db = Database::open(&path).unwrap();
        let (pid, _) = page_abc(&db, &target);
        pid
    };
    let edited = read(&target, "Plans.md").replace("alpha", "outside");
    fs::write(target.dir.join("Plans.md"), &edited).unwrap();
    fs::write(target.dir.join("Fresh.md"), "- new").unwrap();
    let ro = Database::open_read_only(&path).unwrap();
    let r = import_outside_edits(&ro, &target, &Scope::All).unwrap();
    assert!(r.is_empty());
    assert_eq!(texts(&ro, &pid)[0], "alpha");
    assert_eq!(read(&target, "Plans.md"), edited);
}

#[test]
fn files_pulled_by_git_sync_are_not_outside_edits() {
    let (_tmp, db, target) = setup();
    let (pid, _) = page_abc(&db, &target);
    // Simulate a pull that sync imported: file and DB agree, but the hash moved.
    let pulled = read(&target, "Plans.md").replace("beta", "beta from device B");
    fs::write(target.dir.join("Plans.md"), &pulled).unwrap();
    db.sync_dir_with(&target.dir, "git-sync", &Default::default()).unwrap();
    adopt_pulled_files(&db, &target, Some(&["Plans.md".to_string()])).unwrap();
    let r = run(&db, &target, false).unwrap();
    assert!(r.outside.is_empty(), "{:?}", r.outside);
    assert!(db.get_page_by_title("Plans (edited outside)").unwrap().is_none());
    assert_eq!(texts(&db, &pid)[1], "beta from device B");
}
