//! Import tests against the hand-built fixtures in `tests/fixtures/import/`
//! (regenerate them with `make_fixtures.py`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use super::*;
use crate::db::Database;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/import")
}

fn no_progress(_: Progress) {}

fn scan_vault(path: &Path, kind: SourceKind) -> Model {
    let spec = SourceSpec { kind, paths: vec![path.to_path_buf()] };
    scan(&spec, &ImportOptions::default(), &Limits::default(), &AtomicBool::new(false), &no_progress).unwrap()
}

fn scan_enex(files: &[&str], limits: &Limits) -> Result<Model> {
    let spec = SourceSpec { kind: SourceKind::Evernote, paths: files.iter().map(|f| fixtures().join(f)).collect() };
    scan(&spec, &ImportOptions::default(), limits, &AtomicBool::new(false), &no_progress)
}

fn db() -> (tempfile::TempDir, Database) {
    let t = tempfile::tempdir().unwrap();
    let db = Database::open(&t.path().join("notebook.minotes")).unwrap();
    (t, db)
}

fn run_import(db: &Database, model: &Model, dest: &Destination) -> ImportReport {
    import(db, model, &ImportOptions::default(), dest, &AtomicBool::new(false), &no_progress).unwrap()
}

fn page(db: &Database, title: &str) -> crate::models::Page {
    db.get_page_by_title(title).unwrap().unwrap_or_else(|| panic!("no page {title:?}"))
}

fn contents(db: &Database, title: &str) -> Vec<String> {
    db.get_page_blocks(&page(db, title).id).unwrap().into_iter().map(|b| b.content).collect()
}

fn prop(db: &Database, id: &uuid::Uuid, key: &str) -> Option<String> {
    db.get_properties(id).unwrap().into_iter().find(|p| p.key == key).and_then(|p| p.value)
}

// ── Readers: the neutral model ──

#[test]
fn obsidian_reader_builds_the_neutral_model() {
    let m = scan_vault(&fixtures().join("obsidian-vault"), SourceKind::Obsidian);
    let keys: Vec<&str> = m.notes.iter().map(|n| n.key.as_str()).collect();
    assert!(!keys.iter().any(|k| k.contains(".trash") || k.contains(".obsidian")), "{keys:?}");
    assert!(keys.contains(&"Home.md") && keys.contains(&"Projects/Sub/Deep.md"));
    let home = m.notes.iter().find(|n| n.key == "Home.md").unwrap();
    assert_eq!(home.tags, vec!["moc", "project/active"]);
    assert_eq!(home.aliases, vec!["Start Here", "Dashboard"]);
    assert!(home.properties.contains(&("status".into(), "active".into())));
    assert!(home.body.contains("> **Warning** Mind the gap"), "callout");
    assert!(home.body.contains("<!--hidden comment-->"), "comment");
    let renamed = m.notes.iter().find(|n| n.key == "Projects/Renamed.md").unwrap();
    assert_eq!(renamed.title, "Renamed by frontmatter");
    let daily: Vec<_> = m.notes.iter().filter(|n| n.journal.is_some()).map(|n| n.key.as_str()).collect();
    assert_eq!(daily, vec!["Daily/2024-01-15.md", "Daily/2024-01-16.md"]);
    assert!(m.notes.iter().any(|n| n.kind == NoteKind::Canvas && n.title == "Board (canvas)"));
    assert!(m.notes.iter().any(|n| n.kind == NoteKind::Excalidraw && n.title == "Sketch (Excalidraw)"));
    let folders: Vec<&str> = m.folders.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(folders, vec!["Archive", "Daily", "Drawings", "Projects", "Projects/Sub"]);
    let atts: Vec<&str> = m.attachments.iter().map(|a| a.key.as_str()).collect();
    assert!(atts.contains(&"attachments/photo one.jpg") && atts.contains(&"Board.canvas") && atts.contains(&"Unreferenced/old-scan.png"));
    for c in ["callout", "comment", "math", "dataview", "tasks_query", "canvas", "excalidraw"] {
        assert!(m.warnings.count(c) > 0, "{c} counted");
    }
}

#[test]
fn markdown_reader_has_no_vault_rules() {
    let m = scan_vault(&fixtures().join("obsidian-vault"), SourceKind::Markdown);
    assert!(m.notes.iter().all(|n| n.journal.is_none() && n.kind != NoteKind::Canvas));
    let home = m.notes.iter().find(|n| n.key == "Home.md").unwrap();
    assert!(home.body.contains("> [!warning] Mind the gap"), "callouts untouched in plain markdown");
}

#[test]
fn enex_reader_builds_the_neutral_model() {
    let m = scan_enex(&["evernote/Travel.enex"], &Limits::default()).unwrap();
    assert_eq!(m.folders.len(), 1);
    assert_eq!(m.folders[0].name, "Travel");
    let titles: Vec<&str> = m.notes.iter().map(|n| n.title.as_str()).collect();
    assert_eq!(titles, vec!["Packing list", "Trip photos", "Secret", "Itinerary", "Web clip", "Links", "Packing list"]);
    let pack = &m.notes[0];
    assert_eq!(pack.tags, vec!["travel", "todo"]);
    assert!(pack.body.contains("- [x] Passport\n- [ ] Sunscreen\n- [ ] Charger"), "{}", pack.body);
    assert!(pack.properties.iter().any(|(k, v)| k == "created" && v.starts_with("2024-01-05T10:00:00")));
    let photos = &m.notes[1];
    assert!(photos.body.contains("![beach.png](minotes-att:"), "{}", photos.body);
    assert!(photos.body.contains("[ticket.pdf](minotes-att:"), "{}", photos.body);
    assert!(photos.body.contains("**Attachments**"), "unreferenced resource listed");
    for k in ["latitude", "longitude", "author", "source-url", "reminder-time"] {
        assert!(photos.properties.iter().any(|(p, _)| p == k), "{k}");
    }
    assert_eq!(m.attachments.len(), 3);
    assert!(m.attachments.iter().all(|a| matches!(a.data, Some(model::AttachmentData::Spooled(_)))));
    assert!(m.notes[2].body.contains("Encrypted Evernote text — not imported"));
    let itin = &m.notes[3].body;
    for want in ["# Day one", "**noon**", "*the hotel*", "[the hotel site](https://example.com/hotel)", "- Walk\n  - Old town", "1. First", "| Time | What |", "==Highlighted text==", "`inline code`", "```\npreformatted\n  block\n```", "---", "> A quote", "Free day & rest\u{a0}time."] {
        assert!(itin.contains(want), "missing {want:?} in:\n{itin}");
    }
    assert!(!itin.contains("Comic Sans"), "fonts dropped");
    for c in ["en_crypt", "nested_table", "heavy_clip", "reminder"] {
        assert!(m.warnings.count(c) > 0, "{c}");
    }
}

// ── Resolver ──

#[test]
fn resolver_links_on_the_fixture_vault() {
    let m = scan_vault(&fixtures().join("obsidian-vault"), SourceKind::Obsidian);
    let p = preview(&m, &ImportOptions::default(), &|_| false, &HashMap::new());
    let r = resolve::resolve(
        &m,
        &resolve::ResolveCtx { title_taken: &|_| false, reimport: &HashMap::new(), collisions: Collision::KeepBoth, unlinked_files: true },
    );
    let home = &r.notes.iter().find(|n| n.key == "Home.md").unwrap().body;
    for want in [
        "[[Alpha]]",
        "[[Alpha|the alpha project]]",
        "[[Renamed by frontmatter]]",
        "[[Beta|Beta > Section Two]]",
        "((minotes-blockref:",
        "[[Missing Note]]",
        "[[Journal/2024-01-15|2024-01-15]]",
        "[[Deep|Deep note]]",
        "[[Start Here]]",
        "![diagram.png](minotes-att:",
        "![Holiday photo](minotes-att:",
        "[report.pdf](minotes-att:",
        "print(\"[[not a link]]\")",
    ] {
        assert!(home.contains(want), "missing {want:?} in:\n{home}");
    }
    assert_eq!(r.warnings.count("unresolved_link"), 1, "only [[Missing Note]]");
    assert_eq!(r.warnings.count("missing_file"), 1, "missing-image.png");
    assert_eq!(r.warnings.count("ambiguous_link"), 1, "Meeting");
    assert!(r.warnings.count("title_mapped") >= 1, "Q&A [draft]");
    assert!(r.notes.iter().any(|n| n.title == "Q&A (draft)"));
    let unlinked = r.notes.iter().find(|n| n.kind == NoteKind::UnlinkedFiles).unwrap();
    assert!(unlinked.body.contains("old-scan.png"));
    assert_eq!(p.counts.journals, 2);
}

// ── Writer ──

#[test]
fn writer_imports_the_vault_in_outline_order() {
    let (_t, db) = db();
    let m = scan_vault(&fixtures().join("obsidian-vault"), SourceKind::Obsidian);
    let rep = run_import(&db, &m, &Destination::Root);
    assert!(rep.pages_created >= 14, "{rep:?}");
    assert_eq!(rep.journals_created, 2);
    assert_eq!(rep.folders_created, 5);
    // Projects mirror the folders.
    let projects = db.get_folder(&page(&db, "Deep").folder_id.unwrap()).unwrap().unwrap();
    assert_eq!(projects.name, "Sub");
    // Outline order with per-parent positions: headings own their content.
    let blocks = db.get_page_blocks(&page(&db, "Alpha").id).unwrap();
    let shape: Vec<(String, Option<usize>)> = blocks
        .iter()
        .map(|b| (b.content.clone(), b.parent_id.map(|p| blocks.iter().position(|x| x.id == p).unwrap())))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("# Alpha".to_string(), None),
            ("Alpha is a project. Back to [[Home]].".to_string(), Some(0)),
            ("Milestone 1".to_string(), Some(0)),
            ("Task under milestone".to_string(), Some(2)),
            ("Milestone 2".to_string(), Some(0)),
        ]
    );
    // Properties, tags, aliases.
    let home = page(&db, "Home");
    assert_eq!(prop(&db, &home.id, "import_source").as_deref(), Some("obsidian"));
    assert_eq!(prop(&db, &home.id, "import_ref").as_deref(), Some("Home.md"));
    assert_eq!(prop(&db, &home.id, "import_run").as_deref(), Some(rep.run_id.as_str()));
    assert_eq!(prop(&db, &home.id, "tags").as_deref(), Some("#moc #project/active"));
    assert_eq!(db.resolve_alias("Dashboard").unwrap().unwrap().id, home.id);
    // Journals.
    let j = db.find_journal(chrono::NaiveDate::from_ymd_opt(2024, 1, 15).unwrap()).unwrap().unwrap();
    assert!(j.is_journal);
    // Links resolve to pages (link rows exist), block refs point at Beta's block.
    let home_blocks = contents(&db, "Home");
    let joined = home_blocks.join("\n");
    let beta_key = db.get_page_blocks(&page(&db, "Beta").id).unwrap().into_iter().find(|b| b.content == "The key point of this note.").unwrap();
    assert!(joined.contains(&format!("(({}))", beta_key.id)), "{joined}");
    let backlinks: i64 = db.conn.query_row("SELECT COUNT(*) FROM links WHERE to_block = ?1", [beta_key.id.to_string()], |r| r.get(0)).unwrap();
    assert_eq!(backlinks, 1, "block ref link row");
    let to_alpha: i64 = db.conn.query_row("SELECT COUNT(*) FROM links WHERE to_page = ?1", [page(&db, "Alpha").id.to_string()], |r| r.get(0)).unwrap();
    assert!(to_alpha >= 3);
    // Attachments: stored once, referenced by hash, files in the notebook folder.
    assert!(joined.contains("![diagram.png](attachment:"), "{joined}");
    let atts = db.list_attachments().unwrap();
    assert_eq!(atts.len(), rep.attachments_created);
    assert!(atts.iter().all(|a| db.attachment_file(&a.hash).unwrap().starts_with(_t.path().join("attachments"))));
    let unlinked = contents(&db, "Unlinked files").join("\n");
    assert!(unlinked.contains("old-scan.png") && unlinked.contains("](attachment:"), "{unlinked}");
    // Report page with the warnings.
    let report = contents(&db, rep.report_page_title.as_deref().unwrap()).join("\n");
    assert!(report.contains("Dataview queries"), "{report}");
    assert!(report.contains("[[Home]]"));
}

#[test]
fn writer_imports_enex_with_resources() {
    let (_t, db) = db();
    let m = scan_enex(&["evernote/Travel.enex", "evernote/Recipes.enex"], &Limits::default()).unwrap();
    let rep = run_import(&db, &m, &Destination::NewProject { name: Some("From Evernote".into()) });
    assert_eq!(rep.folders_created, 3, "the wrapping Project + one per .enex");
    assert_eq!(rep.attachments_created, 3);
    assert!(db.get_page_by_title("Packing list (2)").unwrap().is_some(), "duplicate title numbered");
    let photos = contents(&db, "Trip photos").join("\n");
    assert!(photos.contains("![beach.png](attachment:"), "{photos}");
    let links = contents(&db, "Links").join("\n");
    assert!(links.contains("[[Itinerary]]") && links.contains("a note elsewhere") && !links.contains("evernote:"), "{links}");
    let pancakes = contents(&db, "Pancakes").join("\n");
    assert!(pancakes.contains("[[Itinerary]]"), "cross-notebook link by title: {pancakes}");
    let todo = contents(&db, "Packing list");
    assert!(todo.contains(&"- [x] Passport".to_string()) && todo.contains(&"- [ ] Sunscreen".to_string()), "{todo:?}");
    assert_eq!(db.count_pending_todos().unwrap(), 2);
    let p = page(&db, "Trip photos");
    assert_eq!(prop(&db, &p.id, "source-url").as_deref(), Some("https://example.com/trip"));
    // The spool of decoded resources goes away with the model.
    let spool = m.spool.as_ref().unwrap().path().to_path_buf();
    drop(m);
    assert!(!spool.exists());
}

// ── Hostile input ──

#[test]
fn hostile_paths_stay_inside_the_source() {
    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path().join("vault");
    std::fs::create_dir_all(vault.join(".obsidian")).unwrap();
    std::fs::copy(fixtures().join("hostile/traversal-vault/Escape.md"), vault.join("Escape.md")).unwrap();
    std::fs::copy(fixtures().join("hostile/traversal-vault/inside.png"), vault.join("inside.png")).unwrap();
    std::fs::write(tmp.path().join("outside.png"), b"secret").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc", vault.join("etc-link")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("outside.png"), vault.join("linked.png")).unwrap();
    }
    let m = scan_vault(&vault, SourceKind::Obsidian);
    assert!(m.attachments.iter().all(|a| a.key == "inside.png"), "{:?}", m.attachments.iter().map(|a| &a.key).collect::<Vec<_>>());
    #[cfg(unix)]
    assert_eq!(m.warnings.count("symlink_skipped"), 2);
    let (_t, db) = db();
    let rep = run_import(&db, &m, &Destination::Root);
    let esc = contents(&db, "Escape").join("\n");
    assert!(!esc.contains("attachment:"), "nothing outside was attached: {esc}");
    assert!(rep.warnings.iter().any(|w| w.category == "path_outside" && w.count >= 3), "{:?}", rep.warnings);
    assert_eq!(db.list_attachments().unwrap().len(), 1, "only the unlinked inside.png");
}

#[test]
fn hostile_enex_inputs() {
    // Entity bomb: nothing expands, quickly.
    let t0 = std::time::Instant::now();
    let m = scan_enex(&["hostile/entity-bomb.enex"], &Limits::default()).unwrap();
    assert!(t0.elapsed().as_secs() < 5);
    assert_eq!(m.notes[0].title, "Bomb &lol9;");
    assert!(m.notes[0].body.contains("&lol9;"));
    assert!(m.warnings.count("unknown_entity") >= 1);
    // en-media pointing at no resource: placeholder + warning; the resource is still attached.
    let m = scan_enex(&["hostile/mismatched-hash.enex"], &Limits::default()).unwrap();
    assert_eq!(m.warnings.count("missing_resource"), 1);
    assert!(m.notes[0].body.contains("[missing attachment 0000"));
    assert!(m.notes[0].body.contains("[red.png](minotes-att:0)") || m.notes[0].body.contains("![red.png](minotes-att:0)"));
    // Duplicate titles are numbered on import.
    let (_t, db) = db();
    let m = scan_enex(&["hostile/duplicate-titles.enex"], &Limits::default()).unwrap();
    run_import(&db, &m, &Destination::Root);
    for t in ["Same", "Same (2)", "Same (3)", "Same (4)"] {
        assert!(db.get_page_by_title(t).unwrap().is_some(), "{t}");
    }
    // Oversized base64: discarded while streaming, reported.
    let small = Limits { max_attachment_bytes: 100 * 1024, ..Limits::default() };
    let m = scan_enex(&["hostile/oversized-base64.enex"], &small).unwrap();
    assert!(m.attachments.is_empty());
    assert_eq!(m.warnings.count("too_large"), 1);
    // Malformed XML: an error, never a panic.
    assert!(scan_enex(&["hostile/malformed.enex"], &Limits::default()).is_err());
    // Deep nesting is capped.
    let m = scan_enex(&["hostile/deep-nesting.enex"], &Limits::default()).unwrap();
    assert!(m.notes[0].body.contains("bottom"));
}

// ── Golden dry-run report ──

#[test]
fn dry_run_preview_matches_the_golden_file() {
    let m = scan_vault(&fixtures().join("obsidian-vault"), SourceKind::Obsidian);
    let p = preview(&m, &ImportOptions::default(), &|_| false, &HashMap::new());
    let got = serde_json::to_string_pretty(&p).unwrap() + "\n";
    let golden = fixtures().join("obsidian-vault.preview.json");
    if std::env::var_os("UPDATE_GOLDEN").is_some() || !golden.exists() {
        std::fs::write(&golden, &got).unwrap();
    }
    let want = std::fs::read_to_string(&golden).unwrap();
    assert_eq!(got, want, "dry-run JSON changed; rerun with UPDATE_GOLDEN=1 if intended");
    let m = scan_enex(&["evernote/Travel.enex"], &Limits::default()).unwrap();
    let p = preview(&m, &ImportOptions::default(), &|_| false, &HashMap::new());
    let got = serde_json::to_string_pretty(&p).unwrap() + "\n";
    let golden = fixtures().join("evernote.preview.json");
    if std::env::var_os("UPDATE_GOLDEN").is_some() || !golden.exists() {
        std::fs::write(&golden, &got).unwrap();
    }
    assert_eq!(got, std::fs::read_to_string(&golden).unwrap());
}

// ── Re-import, undo, cancel ──

fn copy_dir(src: &Path, dst: &Path) {
    for e in walk(src) {
        let rel = e.strip_prefix(src).unwrap();
        let to = dst.join(rel);
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(&e, &to).unwrap();
    }
}

fn walk(p: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(p).unwrap().flatten() {
        if e.file_type().unwrap().is_dir() {
            out.extend(walk(&e.path()));
        } else {
            out.push(e.path());
        }
    }
    out
}

#[test]
fn reimport_is_idempotent_and_respects_edits() {
    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path().join("MyVault");
    copy_dir(&fixtures().join("obsidian-vault"), &vault);
    let (_t, db) = db();
    let dest = Destination::NewProject { name: None };
    let first = run_import(&db, &scan_vault(&vault, SourceKind::Obsidian), &dest);
    let pages_before: i64 = db.conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();

    // Same source again: nothing new except the report page.
    let again = run_import(&db, &scan_vault(&vault, SourceKind::Obsidian), &dest);
    assert_eq!(again.pages_created, 0, "{again:?}");
    assert_eq!(again.pages_unchanged, first.pages_created);
    assert_eq!(again.folders_created, 0, "Projects reused");
    let pages_after: i64 = db.conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
    assert_eq!(pages_after, pages_before + 1);

    // Changed at the source, untouched here → updated in place.
    std::fs::write(vault.join("Beta.md"), "# Beta\n\nRewritten at the source.\n").unwrap();
    // Changed in both → "(reimported)" copy, the user's page is kept.
    std::fs::write(vault.join("Projects/Alpha.md"), "# Alpha\n\nChanged at the source too.\n").unwrap();
    let alpha = page(&db, "Alpha");
    let b0 = db.get_page_blocks(&alpha.id).unwrap()[1].clone();
    db.update_block(&b0.id, Some("Edited in MiNotes"), "user").unwrap();
    let third = run_import(&db, &scan_vault(&vault, SourceKind::Obsidian), &dest);
    assert_eq!(third.pages_updated, 1, "{third:?}");
    assert_eq!(third.reimported_copies, 1);
    assert_eq!(contents(&db, "Beta"), vec!["# Beta", "Rewritten at the source."]);
    assert!(contents(&db, "Alpha").contains(&"Edited in MiNotes".to_string()));
    assert!(contents(&db, "Alpha (reimported)").contains(&"Changed at the source too.".to_string()));
}

#[test]
fn undo_is_exact_and_refuses_edited_pages() {
    let (_t, db) = db();
    let mine = db.create_page("My own page", None, false, None, "user").unwrap();
    let m = scan_vault(&fixtures().join("obsidian-vault"), SourceKind::Obsidian);
    let rep = run_import(&db, &m, &Destination::NewProject { name: None });
    assert!(rep.attachments_created > 0);
    // Edit one imported page: undo refuses and lists it.
    let beta = page(&db, "Beta");
    let b = db.get_page_blocks(&beta.id).unwrap()[0].clone();
    db.update_block(&b.id, Some("# Beta (edited)"), "user").unwrap();
    let refused = undo(&db, &rep.run_id, false).unwrap();
    assert!(!refused.undone);
    assert_eq!(refused.edited.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(), vec!["Beta"]);
    assert!(db.get_page_by_title("Home").unwrap().is_some(), "nothing changed");
    // Revert the edit: undo removes exactly what the run created.
    db.update_block(&b.id, Some("# Beta"), "user").unwrap();
    let done = undo(&db, &rep.run_id, false).unwrap();
    assert!(done.undone && done.edited.is_empty(), "{done:?}");
    let left: Vec<String> = db.list_pages(Some(1000)).unwrap().into_iter().map(|p| p.title).collect();
    assert_eq!(left, vec!["My own page".to_string()]);
    assert!(db.get_folder_tree().unwrap().is_empty());
    assert!(db.list_attachments().unwrap().is_empty());
    assert!(db.get_page(&mine.id).unwrap().is_some());
    assert_eq!(list_runs(&db).unwrap()[0].status, "undone");
    // keep_edited: undo the rest, keep (and list) the edited page and its Project.
    let rep = run_import(&db, &m, &Destination::Root);
    let alpha = page(&db, "Alpha");
    let ab = db.get_page_blocks(&alpha.id).unwrap()[0].clone();
    db.update_block(&ab.id, Some("# Alpha!"), "user").unwrap();
    let partial = undo(&db, &rep.run_id, true).unwrap();
    assert!(partial.undone);
    assert_eq!(partial.edited.len(), 1);
    let left: Vec<String> = db.list_pages(Some(1000)).unwrap().into_iter().map(|p| p.title).collect();
    assert_eq!(left.len(), 2, "{left:?}");
    assert!(db.get_folder(&alpha.folder_id.unwrap()).unwrap().is_some(), "its Project stays");
}

#[test]
fn cancel_rolls_everything_back() {
    let (_t, db) = db();
    let m = scan_vault(&fixtures().join("obsidian-vault"), SourceKind::Obsidian);
    let cancel = AtomicBool::new(false);
    let opts = ImportOptions { batch_size: 3, ..ImportOptions::default() };
    let progress = |p: Progress| {
        if p.phase == "import" && p.done >= 6 {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    };
    let err = import(&db, &m, &opts, &Destination::Root, &cancel, &progress).unwrap_err();
    assert!(is_cancelled(&err), "{err}");
    let pages: i64 = db.conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0)).unwrap();
    assert_eq!(pages, 0);
    assert!(db.get_folder_tree().unwrap().is_empty());
    assert!(db.list_attachments().unwrap().is_empty());
    let store = _t.path().join("attachments");
    let files: Vec<_> = if store.exists() { walk(&store) } else { vec![] };
    assert!(files.is_empty(), "{files:?}");
    assert_eq!(list_runs(&db).unwrap()[0].status, "cancelled");
}

// ── Mirror carries attachments; sync brings them back ──

#[test]
fn mirror_carries_attachments_and_sync_reverses_links() {
    let (t, db) = db();
    let m = scan_vault(&fixtures().join("obsidian-vault"), SourceKind::Obsidian);
    run_import(&db, &m, &Destination::Root);
    let mirror = t.path().join("notes");
    let target = crate::mirror::MirrorTarget::new(&mirror, Some(t.path().join("state.json")));
    crate::mirror::run(&db, &target, true).unwrap();
    let home = std::fs::read_to_string(mirror.join("Home.md")).unwrap();
    assert!(home.contains("](_attachments/"), "{home}");
    assert!(!home.contains("attachment:"));
    let deep = std::fs::read_to_string(mirror.join("Projects/Sub/Deep.md")).unwrap();
    let _ = deep;
    let diag = db.list_attachments().unwrap().into_iter().find(|a| a.name == "diagram.png").unwrap();
    assert!(mirror.join("_attachments").join(&diag.hash).join("diagram.png").is_file());
    assert!(!mirror.join("_attachments").join(".minotes-folder.json").exists());

    // Another device: a fresh notebook syncing that folder gets pages AND files,
    // and the links are attachment references again.
    let (_t2, db2) = super::tests::db();
    let r = db2.sync_dir(&mirror, "sync", false, false).unwrap();
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let home2 = contents(&db2, "Home").join("\n");
    assert!(home2.contains(&format!("![diagram.png](attachment:{}/diagram.png)", diag.hash)), "{home2}");
    assert!(db2.attachment_file(&diag.hash).is_some());
    assert!(db2.get_folder_tree().unwrap().iter().all(|f| f.folder.name != "_attachments"));
    // A second sync pass changes nothing.
    let r2 = db.sync_dir(&mirror, "sync", false, false).unwrap();
    assert!(r2.pages_updated.is_empty(), "{:?}", r2.pages_updated);
}
