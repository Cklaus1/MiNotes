use std::path::Path;

use super::*;
use crate::git_cmd;
use crate::git_cmd::tests::setup_remote_and_devices;
use crate::sync_manager::{sync_cycle_in_dir, GitSyncResult};

fn cycle(dir: &Path, db: &Database) -> GitSyncResult {
    let r = sync_cycle_in_dir(dir, || Ok(db)).unwrap();
    assert!(r.success, "sync failed: {:?}", r.error);
    r
}

fn texts(db: &Database, page: &Uuid) -> Vec<String> {
    db.get_page_blocks(page).unwrap().into_iter().map(|b| b.content).collect()
}

fn copy_of(db: &Database, title: &str) -> crate::models::Page {
    db.list_pages(None)
        .unwrap()
        .into_iter()
        .find(|p| p.title.starts_with(&format!("{title} (conflict from ")))
        .unwrap_or_else(|| panic!("no conflict copy of {title}"))
}

fn pick(cmp: &ConflictCompare, choice: Choice) -> Vec<ConflictChoice> {
    cmp.rows.iter().map(|r| ConflictChoice { key: r.key.clone(), choice }).collect()
}

/// Two devices, a page of three blocks; both change block 2 (and B also block
/// 3, which merges cleanly). Returns (A's db, B's db, page id, ids, dirs).
struct Setup {
    _tmp: tempfile::TempDir,
    a: std::path::PathBuf,
    b: std::path::PathBuf,
    db_a: Database,
    db_b: Database,
    page: Uuid,
    blocks: Vec<Uuid>,
}

fn same_block_conflict() -> Option<Setup> {
    if !git_cmd::git_available() {
        return None;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (_remote, a, b) = setup_remote_and_devices(tmp.path());
    let db_a = Database::open_in_memory().unwrap();
    let db_b = Database::open_in_memory().unwrap();
    let p = db_a.create_page("Plan", None, false, None, "user").unwrap();
    let ids: Vec<Uuid> = ["one", "two", "three"]
        .iter()
        .map(|t| db_a.create_block(&p.id, t, None, None, "user").unwrap().id)
        .collect();
    cycle(&a, &db_a);
    cycle(&b, &db_b);
    db_b.update_block(&ids[1], Some("two from B"), "user").unwrap();
    db_b.update_block(&ids[2], Some("three from B"), "user").unwrap();
    cycle(&b, &db_b);
    db_a.update_block(&ids[1], Some("two from A"), "user").unwrap();
    let r = cycle(&a, &db_a);
    assert_eq!(r.conflict_pages.len(), 1, "{r:?}");
    Some(Setup { _tmp: tmp, a, b, db_a, db_b, page: p.id, blocks: ids })
}

#[test]
fn parses_conflict_titles() {
    assert_eq!(parse_conflict_title("Plan (conflict from laptop)"), Some(("Plan".into(), "laptop".into())));
    assert_eq!(parse_conflict_title("Plan (conflict from laptop) (2)"), Some(("Plan".into(), "laptop".into())));
    assert_eq!(parse_conflict_title("A (b) (conflict from my-pc.local)"), Some(("A (b)".into(), "my-pc.local".into())));
    assert_eq!(parse_conflict_title("Plan (2)"), None);
    assert_eq!(parse_conflict_title("Plan"), None);
    assert_eq!(parse_conflict_title(" (conflict from x)"), None);
}

// The compare view pairs blocks by id and shows only the block both devices
// changed — not the one that merged cleanly, not the unchanged one.
#[test]
fn compare_shows_only_the_conflicting_block() {
    let Some(s) = same_block_conflict() else { return };
    assert_eq!(texts(&s.db_a, &s.page), ["one", "two from A", "three from B"], "local kept, the rest merged");
    let copy = copy_of(&s.db_a, "Plan");
    let cmp = s.db_a.conflict_compare(&copy.id).unwrap();
    assert!(cmp.exact, "paired by id");
    assert_eq!(cmp.page_id, Some(s.page));
    assert_eq!(cmp.rows.len(), 1, "{:?}", cmp.rows);
    let r = &cmp.rows[0];
    assert_eq!(r.mine.as_ref().unwrap().block_id, s.blocks[1]);
    assert_eq!(r.mine.as_ref().unwrap().content, "two from A");
    assert_eq!(r.theirs.as_ref().unwrap().content, "two from B");
    // The copy (and its pairing) reached device B too: same rows there.
    cycle(&s.a, &s.db_a);
    cycle(&s.b, &s.db_b);
    let copy_b = copy_of(&s.db_b, "Plan");
    assert_eq!(copy_b.id, copy.id);
    let cmp_b = s.db_b.conflict_compare(&copy_b.id).unwrap();
    assert!(cmp_b.exact);
    assert_eq!(cmp_b.rows.len(), 1, "{:?}", cmp_b.rows);
    assert_eq!(cmp_b.rows[0].mine.as_ref().unwrap().content, "two from A");
}

// Keep theirs: one transaction changes the block and trashes the copy; the
// returned snapshot undoes it exactly (copy back from the Trash), and redoes it.
#[test]
fn keep_theirs_is_one_undoable_step() {
    let Some(s) = same_block_conflict() else { return };
    let db = &s.db_a;
    cycle(&s.a, &s.db_a);
    cycle(&s.b, &s.db_b);
    let copy = copy_of(db, "Plan");
    assert_eq!(copy_of(&s.db_b, "Plan").id, copy.id, "B has the copy too");
    let cmp = db.conflict_compare(&copy.id).unwrap();
    let before_ids: Vec<Uuid> = db.get_page_blocks(&s.page).unwrap().into_iter().map(|b| b.id).collect();
    let res = db.resolve_conflict(&copy.id, &pick(&cmp, Choice::Theirs)).unwrap();
    assert_eq!(texts(db, &s.page), ["one", "two from B", "three from B"]);
    assert!(db.is_trashed(&copy.id).unwrap(), "the copy is in the Trash");
    assert_eq!(res.took_theirs, 1);
    assert_eq!(res.before.iter().map(|b| b.content.as_str()).collect::<Vec<_>>(), ["one", "two from A", "three from B"]);

    db.set_conflict_resolution(&res.page_id, &res.copy_id, &res.before, false).unwrap();
    assert_eq!(texts(db, &s.page), ["one", "two from A", "three from B"], "undo");
    assert_eq!(db.get_page_blocks(&s.page).unwrap().into_iter().map(|b| b.id).collect::<Vec<_>>(), before_ids, "same ids");
    assert!(!db.is_trashed(&copy.id).unwrap(), "undo brings the copy back");
    assert_eq!(db.conflict_compare(&copy.id).unwrap().rows.len(), 1, "and it compares again");

    db.set_conflict_resolution(&res.page_id, &res.copy_id, &res.after, true).unwrap();
    assert_eq!(texts(db, &s.page), ["one", "two from B", "three from B"], "redo");
    assert!(db.is_trashed(&copy.id).unwrap());

    // The resolution syncs: B gets the text and loses the copy (to its Trash).
    cycle(&s.a, &s.db_a);
    cycle(&s.b, &s.db_b);
    assert_eq!(texts(&s.db_b, &s.page), ["one", "two from B", "three from B"]);
    assert!(s.db_b.is_trashed(&copy.id).unwrap(), "trashed on the other device too");
}

// Keep both: the other version goes right after mine, as its own block.
#[test]
fn keep_both_inserts_theirs_after_mine() {
    let Some(s) = same_block_conflict() else { return };
    let db = &s.db_a;
    let copy = copy_of(db, "Plan");
    let cmp = db.conflict_compare(&copy.id).unwrap();
    let res = db.resolve_conflict(&copy.id, &pick(&cmp, Choice::Both)).unwrap();
    assert_eq!(texts(db, &s.page), ["one", "two from A", "two from B", "three from B"]);
    assert_eq!(res.kept_both, 1);
    assert!(db.is_trashed(&copy.id).unwrap());
    db.set_conflict_resolution(&res.page_id, &res.copy_id, &res.before, false).unwrap();
    assert_eq!(texts(db, &s.page), ["one", "two from A", "three from B"], "undo removes the added block");
}

// All or nothing: a missing choice, an unknown row, or a failure half-way
// (the copy can't be trashed) leave the page and the copy exactly as they were.
#[test]
fn resolve_is_atomic() {
    let Some(s) = same_block_conflict() else { return };
    let db = &s.db_a;
    let copy = copy_of(db, "Plan");
    let cmp = db.conflict_compare(&copy.id).unwrap();
    let e = db.resolve_conflict(&copy.id, &[]).unwrap_err();
    assert!(e.to_string().contains("Choose a version for every block (1 left)"), "{e}");
    let bogus = vec![ConflictChoice { key: "x|y".into(), choice: Choice::Theirs }];
    assert!(db.resolve_conflict(&copy.id, &bogus).is_err());

    db.conn
        .execute_batch("CREATE TEMP TRIGGER no_trash BEFORE INSERT ON trash BEGIN SELECT RAISE(ABORT, 'disk full'); END;")
        .unwrap();
    let e = db.resolve_conflict(&copy.id, &pick(&cmp, Choice::Theirs)).unwrap_err();
    assert!(e.to_string().contains("disk full"), "{e}");
    assert_eq!(texts(db, &s.page), ["one", "two from A", "three from B"], "the block edit was rolled back");
    assert!(!db.is_trashed(&copy.id).unwrap());
    db.conn.execute_batch("DROP TRIGGER no_trash;").unwrap();
    assert!(db.resolve_conflict(&copy.id, &pick(&cmp, Choice::Mine)).is_ok());
    assert_eq!(texts(db, &s.page), ["one", "two from A", "three from B"], "keep mine changes nothing");
    assert!(db.is_trashed(&copy.id).unwrap());
}

// A copy made before block ids were derived (random ids): paired by aligning
// the two outlines on equal text — only the differing blocks show.
#[test]
fn old_copies_are_compared_by_alignment() {
    let db = Database::open_in_memory().unwrap();
    let p = db.create_page("Notes", None, false, None, "user").unwrap();
    for t in ["a", "b mine", "c", "d"] {
        db.create_block(&p.id, t, None, None, "user").unwrap();
    }
    let c = db.create_page("Notes (conflict from desk)", None, false, None, "git-sync").unwrap();
    for t in ["a", "b theirs", "c", "d", "e new there"] {
        db.create_block(&c.id, t, None, None, "git-sync").unwrap();
    }
    let cmp = db.conflict_compare(&c.id).unwrap();
    assert!(!cmp.exact);
    assert_eq!(cmp.device, "desk");
    assert_eq!(cmp.page_id, Some(p.id));
    let pairs: Vec<(Option<String>, Option<String>)> = cmp
        .rows
        .iter()
        .map(|r| (r.mine.as_ref().map(|m| m.content.clone()), r.theirs.as_ref().map(|t| t.content.clone())))
        .collect();
    assert_eq!(pairs, vec![(Some("b mine".into()), Some("b theirs".into())), (None, Some("e new there".into()))]);
    let choices = vec![
        ConflictChoice { key: cmp.rows[0].key.clone(), choice: Choice::Mine },
        ConflictChoice { key: cmp.rows[1].key.clone(), choice: Choice::Theirs },
    ];
    db.resolve_conflict(&c.id, &choices).unwrap();
    assert_eq!(texts(&db, &p.id), ["a", "b mine", "c", "d", "e new there"]);
}

#[test]
fn not_a_conflict_copy_is_refused() {
    let db = Database::open_in_memory().unwrap();
    let p = db.create_page("Plain", None, false, None, "user").unwrap();
    assert!(db.conflict_compare(&p.id).is_err());
}

// The copy is named after the device that made the other version (from its
// sync commit), never after the device that noticed the conflict.
#[test]
fn device_names_come_from_the_other_devices_commits() {
    assert_eq!(git_cmd::device_of_subject("sync: laptop @ 2026-10-21T10:00:00+00:00"), Some("laptop".into()));
    assert_eq!(git_cmd::device_of_subject("sync: my pc @ host @ 2026-10-21T10:00:00+00:00"), Some("my pc @ host".into()));
    assert_eq!(git_cmd::device_of_subject("Initial commit"), None);
    if !git_cmd::git_available() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git_cmd::init_repo(d).unwrap();
    git_cmd::tests::configure_test_repo(d);
    let me = git_cmd::get_hostname();
    std::fs::write(d.join("a.md"), "1").unwrap();
    git_cmd::commit_all(d, "sync: laptop @ 2026-10-21T10:00:00+00:00").unwrap();
    std::fs::write(d.join("a.md"), "2").unwrap();
    git_cmd::commit_all(d, &format!("sync: {me} @ 2026-10-21T11:00:00+00:00")).unwrap();
    assert_eq!(git_cmd::device_of_last_change(d, "HEAD", "a.md").as_deref(), Some("laptop"), "another host wins over this one");
    std::fs::write(d.join("b.md"), "x").unwrap();
    git_cmd::commit_all(d, &format!("sync: {me} @ 2026-10-21T12:00:00+00:00")).unwrap();
    assert_eq!(git_cmd::device_of_last_change(d, "HEAD", "b.md"), Some(me), "only this host: this host");
    assert_eq!(git_cmd::device_of_last_change(d, "HEAD", "nope.md"), None);
}
