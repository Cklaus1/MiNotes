//! End-to-end tests for the `minotes` binary against throwaway databases.
//! Every test uses its own temp dir and sets HOME to it, so the default notebook
//! path (~/.minotes/...) never touches the real user data.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct TempHome(PathBuf);

impl TempHome {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "minotes-cli-test-{}-{}-{}",
            std::process::id(),
            n,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempHome(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn db(&self) -> String {
        self.0.join("test.db").to_string_lossy().into_owned()
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(home: &TempHome, args: &[&str]) -> Output {
    run_stdin(home, args, None)
}

fn run_stdin(home: &TempHome, args: &[&str], stdin: Option<&str>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_minotes"));
    cmd.args(args)
        .env("HOME", home.path())
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn minotes");
    if let Some(input) = stdin {
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    }
    child.wait_with_output().unwrap()
}

fn json(out: &Output) -> serde_json::Value {
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "bad json ({e}): stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    })
}

/// Create a fresh notebook database at the temp db path and a page in it; returns the page id.
fn setup_page(h: &TempHome, title: &str) -> String {
    let db = h.db();
    let out = run(h, &["--notebook", &db, "--create", "page", "create", title]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    json(&out)["id"].as_str().unwrap().to_string()
}

#[test]
fn explicit_missing_notebook_db_errors_without_create() {
    let h = TempHome::new();
    let db = h.db();
    let out = run(&h, &["--notebook", &db, "page", "list"]);
    assert!(!out.status.success());
    assert!(!Path::new(&db).exists(), "must not silently create the DB");
    assert!(String::from_utf8_lossy(&out.stderr).contains("not found"));

    let out = run(&h, &["--notebook", &db, "--create", "page", "list"]);
    assert!(out.status.success());
    assert!(Path::new(&db).exists());
}

#[test]
fn default_notebook_is_app_active_notebook_and_tilde_expands() {
    let h = TempHome::new();
    // No --notebook: uses ~/.minotes/default.db (created on demand like the app).
    let out = run(&h, &["page", "create", "Hello"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(h.path().join(".minotes/default.db").exists());

    // active_graph file selects another notebook.
    std::fs::write(h.path().join(".minotes/active_graph"), "work\n").unwrap();
    let out = run(&h, &["page", "list"]);
    assert!(out.status.success());
    assert!(h.path().join(".minotes/work.db").exists());
    assert_eq!(json(&out).as_array().unwrap().len(), 0);

    // ~ in --notebook expands to $HOME.
    let out = run(&h, &["--notebook", "~/.minotes/default.db", "page", "list"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let titles: Vec<_> = json(&out)
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["title"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(titles, vec!["Hello".to_string()]);
}

#[test]
fn page_delete_moves_to_trash_by_default() {
    let h = TempHome::new();
    let db = h.db();
    let id = setup_page(&h, "Doomed");
    let out = run(&h, &["--notebook", &db, "page", "delete", "Doomed"]);
    assert!(out.status.success());

    let out = run(&h, &["--notebook", &db, "query", &format!("SELECT COUNT(*) AS n FROM trash WHERE page_id = '{id}'")]);
    assert_eq!(json(&out)["rows"][0]["n"], 1, "page should be in trash");
    let out = run(&h, &["--notebook", &db, "query", &format!("SELECT COUNT(*) AS n FROM pages WHERE id = '{id}'")]);
    assert_eq!(json(&out)["rows"][0]["n"], 1, "page row must still exist");
}

#[test]
fn page_delete_permanent_requires_yes() {
    let h = TempHome::new();
    let db = h.db();
    let id = setup_page(&h, "Gone");
    // Non-TTY stdin, no --yes → refused.
    let out = run(&h, &["--notebook", &db, "page", "delete", "Gone", "--permanent"]);
    assert!(!out.status.success());
    let q = format!("SELECT COUNT(*) AS n FROM pages WHERE id = '{id}'");
    assert_eq!(json(&run(&h, &["--notebook", &db, "query", &q]))["rows"][0]["n"], 1);

    let out = run(&h, &["--notebook", &db, "page", "delete", "Gone", "--permanent", "--yes"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&run(&h, &["--notebook", &db, "query", &q]))["rows"][0]["n"], 0);
}

#[test]
fn invalid_uuids_are_errors() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    let out = run(&h, &["--notebook", &db, "block", "create", "P", "hi", "--parent", "not-a-uuid"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Invalid parent UUID"));

    for args in [
        vec!["folder", "create", "F", "--parent", "bogus"],
        vec!["folder", "list", "--parent", "bogus"],
    ] {
        let mut full = vec!["--notebook", db.as_str()];
        full.extend(args.iter());
        let out = run(&h, &full);
        assert!(!out.status.success(), "{args:?} should fail");
    }
    // No folder was created by the failed call.
    let out = run(&h, &["--notebook", &db, "folder", "list"]);
    assert_eq!(json(&out).as_array().unwrap().len(), 0);
}

#[test]
fn content_may_start_with_hyphen() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    let out = run(&h, &["--notebook", &db, "block", "create", "P", "- [ ] a task"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["content"], "- [ ] a task");
    let id = json(&out)["id"].as_str().unwrap().to_string();

    let out = run(&h, &["--notebook", &db, "block", "update", &id, "--content", "-x"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["content"], "-x");

    let out = run(&h, &["--notebook", &db, "journal", "create", "-- dash entry", "--date", "2026-01-02"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["content"], "-- dash entry");
}

#[test]
fn batch_create_is_atomic() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    let input = r#"[{"content":"one"},{"content":"two","parent_id":"garbage"}]"#;
    let out = run_stdin(&h, &["--notebook", &db, "batch-create", "P"], Some(input));
    assert!(!out.status.success());
    let q = "SELECT COUNT(*) AS n FROM blocks";
    assert_eq!(json(&run(&h, &["--notebook", &db, "query", q]))["rows"][0]["n"], 0);

    let input = r#"[{"content":"one"},{"content":"two"}]"#;
    let out = run_stdin(&h, &["--notebook", &db, "batch-create", "P"], Some(input));
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["created"], 2);
}

#[test]
fn reindex_rebuilds_search() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    run(&h, &["--notebook", &db, "block", "create", "P", "zebra crossing"]);
    let out = run(&h, &["--notebook", &db, "reindex"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["blocks_indexed"], 1);
    let out = run(&h, &["--notebook", &db, "search", "zebra"]);
    assert!(out.status.success());
    assert_eq!(json(&out)["count"], 1);
}

#[test]
fn csv_quotes_lone_carriage_return() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    run(&h, &["--notebook", &db, "block", "create", "P", "a\rb"]);
    let out = run(&h, &["--notebook", &db, "-f", "csv", "page", "get", "P"]);
    assert!(out.status.success());
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("\"a\rb\""), "lone CR must be quoted: {s:?}");
}

#[test]
fn global_flags_work_after_the_subcommand() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    run(&h, &["--notebook", &db, "block", "create", "P", "hello"]);

    // `-f` / `--notebook` used to be accepted only BEFORE the subcommand.
    let out = run(&h, &["page", "get", "P", "-f", "md", "--notebook", &db]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let md = String::from_utf8_lossy(&out.stdout);
    assert!(md.contains("# P") && md.contains("hello"), "{md}");

    // …and still work before it.
    let out = run(&h, &["--notebook", &db, "-f", "md", "page", "get", "P"]);
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("hello"));
}

/// A notebook folder made by hand (as the app lays it out) and registered.
fn make_notebook(h: &TempHome, folder: &str, name: &str, id: &str) -> PathBuf {
    let root = h.path().join(folder);
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::create_dir_all(root.join(".minotes")).unwrap();
    let db = root.join("notebook.minotes").to_string_lossy().into_owned();
    let out = run(h, &["--notebook", &db, "--create", "page", "create", &format!("{name} page")]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    std::fs::write(
        root.join("notebook.json"),
        format!(r#"{{"name":"{name}","id":"{id}","format_version":1}}"#),
    )
    .unwrap();
    let reg_path = h.path().join(".minotes/notebooks.json");
    std::fs::create_dir_all(h.path().join(".minotes")).unwrap();
    let mut reg: serde_json::Value = std::fs::read_to_string(&reg_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({"notebooks": []}));
    reg["notebooks"].as_array_mut().unwrap().push(serde_json::json!({
        "id": id, "name": name, "path": root.to_string_lossy(),
    }));
    std::fs::write(&reg_path, reg.to_string()).unwrap();
    root
}

fn titles(out: &Output) -> Vec<String> {
    json(out).as_array().unwrap().iter().map(|p| p["title"].as_str().unwrap().to_string()).collect()
}

#[test]
fn notebook_accepts_a_folder_a_path_or_a_name() {
    let h = TempHome::new();
    let work = make_notebook(&h, "MiNotes/Work", "Work", "0195a000-0000-7000-8000-000000000001");
    make_notebook(&h, "Elsewhere/Home", "Home Notes", "0195a000-0000-7000-8000-000000000002");

    // --notebook <folder> opens its notebook.minotes.
    let out = run(&h, &["--notebook", &work.to_string_lossy(), "page", "list"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(titles(&out), vec!["Work page".to_string()]);

    // --notebook <name> resolves through the registry.
    let out = run(&h, &["--notebook", "Home Notes", "page", "list"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(titles(&out), vec!["Home Notes page".to_string()]);
    let out = run(&h, &["page", "list", "--notebook", "Work"]);
    assert_eq!(titles(&out), vec!["Work page".to_string()]);

    // Unknown names and plain folders are errors, never a new empty database.
    let out = run(&h, &["--notebook", "Nope", "page", "list"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("No notebook named"));
    std::fs::create_dir_all(h.path().join("plain")).unwrap();
    let out = run(&h, &["--notebook", &h.path().join("plain").to_string_lossy(), "page", "list"]);
    assert!(!out.status.success());
    assert!(!h.path().join("plain/notebook.minotes").exists());

    // The app's active notebook can be a folder notebook.
    std::fs::write(h.path().join(".minotes/active_graph"), "0195a000-0000-7000-8000-000000000001").unwrap();
    let out = run(&h, &["page", "list"]);
    assert_eq!(titles(&out), vec!["Work page".to_string()]);

    // `notebooks` lists them.
    let out = run(&h, &["notebooks"]);
    let v = json(&out);
    assert_eq!(v["count"], 2);
}

#[test]
fn missing_notebook_folder_is_an_error_not_a_new_notebook() {
    let h = TempHome::new();
    let root = make_notebook(&h, "Drive/Book", "Book", "0195a000-0000-7000-8000-000000000003");
    std::fs::rename(h.path().join("Drive"), h.path().join("Unplugged")).unwrap();
    let out = run(&h, &["--notebook", "Book", "page", "list"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("unavailable"), "{}", String::from_utf8_lossy(&out.stderr));
    std::fs::write(h.path().join(".minotes/active_graph"), "0195a000-0000-7000-8000-000000000003").unwrap();
    let out = run(&h, &["page", "list"]);
    assert!(!out.status.success());
    assert!(!root.exists(), "the missing folder is not recreated");
    let v = json(&run(&h, &["notebooks"]));
    assert_eq!(v["notebooks"][0]["available"], false);
}

#[test]
fn deprecated_graph_flag_still_works_and_warns_on_stderr_only() {
    let h = TempHome::new();
    let db = h.db();
    let out = run(&h, &["--graph", &db, "--create", "page", "create", "Old flag"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    // stdout is still clean JSON; the notice is on stderr.
    assert_eq!(json(&out)["title"], "Old flag");
    assert!(String::from_utf8_lossy(&out.stderr).contains("--graph is deprecated"));
    // After the subcommand too, and it means the same database as --notebook.
    let out = run(&h, &["page", "list", "--graph", &db]);
    assert_eq!(titles(&out), vec!["Old flag".to_string()]);
    let out = run(&h, &["--notebook", &db, "page", "list"]);
    assert_eq!(titles(&out), vec!["Old flag".to_string()]);
    assert!(out.stderr.is_empty(), "no notice for --notebook");
    // --graph and --notebook together are refused.
    let out = run(&h, &["--graph", &db, "--notebook", &db, "page", "list"]);
    assert!(!out.status.success());
}

#[test]
fn notebook_commands_create_list_current_rename_delete() {
    let h = TempHome::new();
    // create: default location ~/MiNotes/<name>, the app's layout.
    let out = run(&h, &["notebook", "create", "Research"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let v = json(&out);
    assert_eq!(v["name"], "Research");
    assert_eq!(v["kind"], "folder");
    let root = h.path().join("MiNotes/Research");
    assert!(root.join("notebook.minotes").is_file());
    assert!(root.join("notebook.json").is_file());
    assert!(root.join("notes").is_dir());

    // --location picks the folder.
    let loc = h.path().join("Elsewhere/Side");
    let out = run(&h, &["notebook", "create", "Side", "--location", &loc.to_string_lossy()]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(loc.join("notebook.minotes").is_file());
    // Same name twice and bad names are refused.
    assert!(!run(&h, &["notebook", "create", "Research"]).status.success());
    assert!(!run(&h, &["notebook", "create", "a.b"]).status.success());

    // --notebook <name> opens the new notebook.
    let out = run(&h, &["--notebook", "Research", "page", "create", "In research"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let out = run(&h, &["-n", "Research", "page", "list"]);
    assert_eq!(titles(&out), vec!["In research".to_string()]);

    // A legacy notebook (~/.minotes/<name>.db) is selectable by name too.
    run(&h, &["page", "create", "In default"]);
    let out = run(&h, &["--notebook", "default", "page", "list"]);
    assert_eq!(titles(&out), vec!["In default".to_string()]);

    // list (and the old `notebooks` spelling).
    let v = json(&run(&h, &["notebook", "list"]));
    assert_eq!(v["count"], 3);
    assert_eq!(json(&run(&h, &["notebooks"]))["count"], 3);
    let out = run(&h, &["notebook", "list", "-f", "text"]);
    assert!(String::from_utf8_lossy(&out.stdout).contains("Research\tfolder\t"));

    // current = the app's open notebook.
    assert_eq!(json(&run(&h, &["notebook", "current"]))["key"], "default");

    // rename keeps the folder.
    let out = run(&h, &["notebook", "rename", "Side", "Side Project"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["name"], "Side Project");
    assert!(loc.join("notebook.minotes").is_file());

    // delete needs --yes and is refused for the app's open notebook.
    let out = run(&h, &["notebook", "delete", "Side Project"]);
    assert!(!out.status.success());
    assert!(loc.join("notebook.minotes").is_file());
    let out = run(&h, &["notebook", "delete", "default", "--yes"]);
    assert!(!out.status.success());
    assert!(h.path().join(".minotes/default.db").is_file());
    let out = run(&h, &["notebook", "delete", "Side Project", "--yes"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(!loc.join("notebook.minotes").exists());
    assert_eq!(json(&run(&h, &["notebook", "list"]))["count"], 2);
}

#[test]
fn notebook_open_registers_an_existing_folder() {
    let h = TempHome::new();
    let root = h.path().join("MiNotes/Shared");
    assert!(run(&h, &["notebook", "create", "Shared"]).status.success());
    // Forget it by wiping the registry, then open the folder again.
    std::fs::remove_file(h.path().join(".minotes/notebooks.json")).unwrap();
    assert_eq!(json(&run(&h, &["notebook", "list"]))["count"], 0);
    let out = run(&h, &["notebook", "open", &root.to_string_lossy()]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["name"], "Shared");
    assert!(run(&h, &["--notebook", "Shared", "page", "list"]).status.success());
}

#[test]
fn search_all_notebooks_labels_results_and_skips_unavailable() {
    let h = TempHome::new();
    for nb in ["Home", "Work", "Gone"] {
        let out = run(&h, &["notebook", "create", nb]);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    run(&h, &["--notebook", "Home", "page", "create", "Groceries"]);
    run(&h, &["--notebook", "Home", "block", "create", "Groceries", "okapi food"]);
    run(&h, &["--notebook", "Work", "page", "create", "Q3 Plan"]);
    run(&h, &["--notebook", "Work", "block", "create", "Q3 Plan", "okapi budget"]);
    std::fs::remove_dir_all(h.path().join("MiNotes/Gone")).unwrap();
    let work_db = h.path().join("MiNotes/Work/notebook.minotes");
    let before = std::fs::read(&work_db).unwrap();

    // Without the flag: only the chosen notebook.
    let v = json(&run(&h, &["--notebook", "Home", "search", "okapi"]));
    assert_eq!(v["count"], 1);

    let v = json(&run(&h, &["--notebook", "Home", "search", "okapi", "--all-notebooks"]));
    assert_eq!(v["count"], 2, "{v}");
    assert_eq!(v["results"][0]["notebook"], "Home", "the open notebook first");
    assert_eq!(v["results"][0]["current_notebook"], true);
    assert_eq!(v["results"][1]["notebook"], "Work");
    assert_eq!(v["results"][1]["page_title"], "Q3 Plan");
    assert_eq!(v["skipped"][0]["notebook_name"], "Gone");
    assert_eq!(v["skipped"][0]["reason"], "unavailable");

    let out = run(&h, &["--notebook", "Home", "-f", "text", "search", "okapi", "--all-notebooks"]);
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("[Work]") && text.contains("[Home]"), "{text}");
    assert!(text.contains("Skipped: Gone (not available)"), "{text}");
    let out = run(&h, &["--notebook", "Home", "-f", "md", "search", "okapi", "--all-notebooks"]);
    let md = String::from_utf8(out.stdout).unwrap();
    assert!(md.contains("## Home") && md.contains("## Work") && md.contains("- okapi budget (Q3 Plan)"), "{md}");
    let out = run(&h, &["--notebook", "Home", "-f", "csv", "search", "okapi", "--all-notebooks"]);
    let csv = String::from_utf8(out.stdout).unwrap();
    assert!(csv.starts_with("notebook,notebook_key,"), "{csv}");
    assert!(csv.lines().any(|l| l.starts_with("Work,")), "{csv}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("Skipped: Gone"));

    // The other notebook was only read.
    assert_eq!(std::fs::read(&work_db).unwrap(), before, "Work's database untouched");
    assert!(!h.path().join("MiNotes/Work/.minotes/lock.json").exists());
}
