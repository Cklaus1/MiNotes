//! End-to-end tests for the `minotes` binary against throwaway databases.
//! Every test uses its own temp dir and sets HOME to it, so the default graph
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

/// Create a fresh graph at the temp db path and a page in it; returns the page id.
fn setup_page(h: &TempHome, title: &str) -> String {
    let db = h.db();
    let out = run(h, &["--graph", &db, "--create", "page", "create", title]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    json(&out)["id"].as_str().unwrap().to_string()
}

#[test]
fn explicit_missing_graph_errors_without_create() {
    let h = TempHome::new();
    let db = h.db();
    let out = run(&h, &["--graph", &db, "page", "list"]);
    assert!(!out.status.success());
    assert!(!Path::new(&db).exists(), "must not silently create the DB");
    assert!(String::from_utf8_lossy(&out.stderr).contains("not found"));

    let out = run(&h, &["--graph", &db, "--create", "page", "list"]);
    assert!(out.status.success());
    assert!(Path::new(&db).exists());
}

#[test]
fn default_graph_is_app_active_graph_and_tilde_expands() {
    let h = TempHome::new();
    // No --graph: uses ~/.minotes/default.db (created on demand like the app).
    let out = run(&h, &["page", "create", "Hello"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(h.path().join(".minotes/default.db").exists());

    // active_graph file selects another graph.
    std::fs::write(h.path().join(".minotes/active_graph"), "work\n").unwrap();
    let out = run(&h, &["page", "list"]);
    assert!(out.status.success());
    assert!(h.path().join(".minotes/work.db").exists());
    assert_eq!(json(&out).as_array().unwrap().len(), 0);

    // ~ in --graph expands to $HOME.
    let out = run(&h, &["--graph", "~/.minotes/default.db", "page", "list"]);
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
    let out = run(&h, &["--graph", &db, "page", "delete", "Doomed"]);
    assert!(out.status.success());

    let out = run(&h, &["--graph", &db, "query", &format!("SELECT COUNT(*) AS n FROM trash WHERE page_id = '{id}'")]);
    assert_eq!(json(&out)["rows"][0]["n"], 1, "page should be in trash");
    let out = run(&h, &["--graph", &db, "query", &format!("SELECT COUNT(*) AS n FROM pages WHERE id = '{id}'")]);
    assert_eq!(json(&out)["rows"][0]["n"], 1, "page row must still exist");
}

#[test]
fn page_delete_permanent_requires_yes() {
    let h = TempHome::new();
    let db = h.db();
    let id = setup_page(&h, "Gone");
    // Non-TTY stdin, no --yes → refused.
    let out = run(&h, &["--graph", &db, "page", "delete", "Gone", "--permanent"]);
    assert!(!out.status.success());
    let q = format!("SELECT COUNT(*) AS n FROM pages WHERE id = '{id}'");
    assert_eq!(json(&run(&h, &["--graph", &db, "query", &q]))["rows"][0]["n"], 1);

    let out = run(&h, &["--graph", &db, "page", "delete", "Gone", "--permanent", "--yes"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&run(&h, &["--graph", &db, "query", &q]))["rows"][0]["n"], 0);
}

#[test]
fn invalid_uuids_are_errors() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    let out = run(&h, &["--graph", &db, "block", "create", "P", "hi", "--parent", "not-a-uuid"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Invalid parent UUID"));

    for args in [
        vec!["folder", "create", "F", "--parent", "bogus"],
        vec!["folder", "list", "--parent", "bogus"],
    ] {
        let mut full = vec!["--graph", db.as_str()];
        full.extend(args.iter());
        let out = run(&h, &full);
        assert!(!out.status.success(), "{args:?} should fail");
    }
    // No folder was created by the failed call.
    let out = run(&h, &["--graph", &db, "folder", "list"]);
    assert_eq!(json(&out).as_array().unwrap().len(), 0);
}

#[test]
fn content_may_start_with_hyphen() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    let out = run(&h, &["--graph", &db, "block", "create", "P", "- [ ] a task"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["content"], "- [ ] a task");
    let id = json(&out)["id"].as_str().unwrap().to_string();

    let out = run(&h, &["--graph", &db, "block", "update", &id, "--content", "-x"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["content"], "-x");

    let out = run(&h, &["--graph", &db, "journal", "create", "-- dash entry", "--date", "2026-01-02"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["content"], "-- dash entry");
}

#[test]
fn batch_create_is_atomic() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    let input = r#"[{"content":"one"},{"content":"two","parent_id":"garbage"}]"#;
    let out = run_stdin(&h, &["--graph", &db, "batch-create", "P"], Some(input));
    assert!(!out.status.success());
    let q = "SELECT COUNT(*) AS n FROM blocks";
    assert_eq!(json(&run(&h, &["--graph", &db, "query", q]))["rows"][0]["n"], 0);

    let input = r#"[{"content":"one"},{"content":"two"}]"#;
    let out = run_stdin(&h, &["--graph", &db, "batch-create", "P"], Some(input));
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["created"], 2);
}

#[test]
fn reindex_rebuilds_search() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    run(&h, &["--graph", &db, "block", "create", "P", "zebra crossing"]);
    let out = run(&h, &["--graph", &db, "reindex"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(json(&out)["blocks_indexed"], 1);
    let out = run(&h, &["--graph", &db, "search", "zebra"]);
    assert!(out.status.success());
    assert_eq!(json(&out)["count"], 1);
}

#[test]
fn csv_quotes_lone_carriage_return() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    run(&h, &["--graph", &db, "block", "create", "P", "a\rb"]);
    let out = run(&h, &["--graph", &db, "-f", "csv", "page", "get", "P"]);
    assert!(out.status.success());
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("\"a\rb\""), "lone CR must be quoted: {s:?}");
}

#[test]
fn global_flags_work_after_the_subcommand() {
    let h = TempHome::new();
    let db = h.db();
    setup_page(&h, "P");
    run(&h, &["--graph", &db, "block", "create", "P", "hello"]);

    // `-f` / `--graph` used to be accepted only BEFORE the subcommand.
    let out = run(&h, &["page", "get", "P", "-f", "md", "--graph", &db]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let md = String::from_utf8_lossy(&out.stdout);
    assert!(md.contains("# P") && md.contains("hello"), "{md}");

    // …and still work before it.
    let out = run(&h, &["--graph", &db, "-f", "md", "page", "get", "P"]);
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("hello"));
}

/// A notebook folder made by hand (as the app lays it out) and registered.
fn make_notebook(h: &TempHome, folder: &str, name: &str, id: &str) -> PathBuf {
    let root = h.path().join(folder);
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::create_dir_all(root.join(".minotes")).unwrap();
    let db = root.join("notebook.minotes").to_string_lossy().into_owned();
    let out = run(h, &["--graph", &db, "--create", "page", "create", &format!("{name} page")]);
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
fn graph_accepts_a_notebook_folder_and_notebook_resolves_by_name() {
    let h = TempHome::new();
    let work = make_notebook(&h, "MiNotes/Work", "Work", "0195a000-0000-7000-8000-000000000001");
    make_notebook(&h, "Elsewhere/Home", "Home Notes", "0195a000-0000-7000-8000-000000000002");

    // --graph <folder> opens its notebook.minotes.
    let out = run(&h, &["--graph", &work.to_string_lossy(), "page", "list"]);
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
    let out = run(&h, &["--graph", &h.path().join("plain").to_string_lossy(), "page", "list"]);
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
