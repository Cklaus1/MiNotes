// Scenario library for silent-errors.sh. Defines window.__scn = { name: async () => outcome }.
// Each scenario drives the UI the way a user would where it can (DOM clicks, filled
// inputs, key events on the focused control) and returns a short string describing
// what the user ends up with. No single quotes in this file.
const S = window.__sig, T = window.__MINOTES__, api = T.modules["/src/lib/api.ts"];
const sleep = S.sleep;
const until = async (f, ms) => { const end = Date.now() + (ms || 4000); while (Date.now() < end) { try { if (await f()) return true; } catch (e) {} await sleep(100); } return false; };
const key = (combo) => { // dispatch on the focused element; reaches React + window handlers
  const parts = combo.split("+"); const k = parts.pop();
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, ctrlKey: parts.includes("Control"), shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt"), bubbles: true, cancelable: true }));
};
const neutral = () => { if (document.activeElement) document.activeElement.blur(); };
const nav = async (t) => { T.navigateTo(t); await until(() => T.getCurrentPage() === t, 3000); await sleep(300); };
const pages = async () => (await api.listPages(5000));
const count = async (title) => (await pages()).filter((p) => p.title === title).length;
const palette = async (text) => {
  if (!T.isPanelOpen("search")) T.openSearch();
  await until(() => document.querySelector(".command-palette-overlay input"));
  const i = document.querySelector(".command-palette-overlay input"); i.focus(); S.fill(i, text); await sleep(900);
  const body = document.querySelector(".command-palette-overlay").innerText.replace(/\s+/g, " ").trim();
  return body.slice(0, 90);
};
const closeAll = async () => { T.closePanel(); neutral(); await sleep(250); };
const sidebarCreate = async (title) => {
  const before = (await pages()).length;
  if (!document.querySelector(".sidebar-actions input[placeholder^=Page]")) S.byText("button", "+ New").click();
  await until(() => document.querySelector(".sidebar-actions input[placeholder^=Page]"));
  const i = document.querySelector(".sidebar-actions input[placeholder^=Page]"); i.focus(); S.fill(i, title); await sleep(100);
  key("Enter"); await sleep(1200);
  const after = await pages();
  const stillOpen = !!document.querySelector(".sidebar-actions input[placeholder^=Page]");
  if (stillOpen) { document.querySelector(".sidebar-actions input[placeholder^=Page]").focus(); key("Escape"); }
  return "pages " + before + "→" + after.length + "; now on \"" + String(T.getCurrentPage()).slice(0, 40) + "\"" + (stillOpen ? "; input stayed open" : "");
};
const titleRename = async (to) => {
  const h = document.querySelector(".main-header h2"); if (!h) return "no title element";
  const from = T.getCurrentPage();
  h.click(); await until(() => document.querySelector(".page-title-input"));
  const i = document.querySelector(".page-title-input"); if (!i) return "title not editable";
  S.fill(i, to); await sleep(100); key("Enter"); await sleep(1300);
  return "title shown: \"" + String(document.querySelector(".main-header h2, .page-title-input")?.innerText || document.querySelector(".page-title-input")?.value).slice(0, 40) + "\"; current page: \"" + String(T.getCurrentPage()).slice(0, 40) + "\" (was \"" + from + "\")";
};
const cmd = async (label) => { // run a command-palette command
  await palette(">" + label); key("Enter"); await sleep(900);
  const open = ["search", "query", "review", "settings"].filter((p) => T.isPanelOpen(p));
  const overlay = document.querySelector(".command-palette-overlay, .settings-overlay, [class*=overlay], [class*=modal]");
  return "panels open after: " + (open.join(",") || "none") + (overlay && S.visible(overlay) ? "; overlay " + String(overlay.className).slice(0, 40) : "; no overlay visible");
};

window.__scn = {
  // ── every view the UX tour visits ─────────────────────────────────────────
  "view: journal": async () => { T.openJournal(); await sleep(1000); return T.getCurrentPage(); },
  "view: rich page": async () => { await nav("Project Alpha"); return T.getBlockCount() + " blocks"; },
  "view: tasks page": async () => { await nav("Research Notes"); return T.getBlockCount() + " blocks"; },
  "view: search palette": async () => palette("alpha"),
  "view: search, no results": async () => palette("zzzqqq-no-match"),
  "view: settings": async () => { neutral(); key("Control+,"); await sleep(800); return "settings open: " + T.isPanelOpen("settings"); },
  "view: graph": async () => { await nav("Project Alpha"); neutral(); key("Control+g"); await sleep(1500); return "graph open: " + T.isPanelOpen("graph"); },
  "view: mindmap": async () => { await nav("Project Alpha"); neutral(); key("Control+m"); await sleep(1500); return "canvas: " + !!document.querySelector(".canvas-layer"); },
  "view: kanban": async () => { await nav("Project Alpha"); neutral(); key("Control+Shift+K"); await sleep(1500); return "canvas: " + !!document.querySelector(".canvas-layer"); },
  "view: whiteboard": async () => { await nav("Project Alpha"); neutral(); key("Control+w"); await sleep(1800); return "canvas element: " + !!document.querySelector("canvas"); },
  "view: all pages": async () => { S.byText(".stats-mode-btn", "Pages").click(); await sleep(1200); return "canvas: " + !!document.querySelector(".canvas-layer"); },
  "view: trash": async () => { const p = await api.createPage("Trash me"); await api.trashPage(p.id); T.refreshSidebar(); await sleep(600); S.byText(".sidebar-system-item", "Trash").click(); await sleep(700); return (document.querySelector(".sidebar-trash-list")?.innerText || "").replace(/\s+/g, " ").slice(0, 60); },
  "view: query panel": async () => { neutral(); key("Control+q"); await sleep(800); return "query open: " + T.isPanelOpen("query"); },
  "view: review panel": async () => { neutral(); key("Control+r"); await sleep(800); return "review open: " + T.isPanelOpen("review"); },
  "view: page info": async () => { await nav("Project Alpha"); document.querySelector(".prop-toggle-btn").click(); await sleep(700); return "info panel shown"; },
  // ── command palette commands ──────────────────────────────────────────────
  "command: Open SQL Query Panel": async () => cmd("SQL"),
  "command: Open Flashcard Review": async () => cmd("Flashcard"),
  "command: Plugins": async () => cmd("Plugin"),
  "command: Sync": async () => cmd("Sync"),
  "command: CSS": async () => cmd("CSS"),
  "command: Settings": async () => cmd("Settings"),
  "command: Export Markdown": async () => cmd("Export Markdown"),
  // ── error-prone actions ───────────────────────────────────────────────────
  "pdf: open a missing file (Ctrl+P)": async () => { S.answer = "/no/such/file.pdf"; neutral(); key("Control+p"); await sleep(2500); const v = document.querySelector(".pdf-viewer"); return v ? "viewer says: " + (v.querySelector(".pdf-load-error")?.innerText || "(nothing)").replace(/\s+/g, " ").slice(0, 100) : "no viewer opened"; },
  "pdf: open a non-PDF file (Ctrl+P)": async () => { S.answer = "/etc/hostname"; neutral(); key("Control+p"); await sleep(2500); const v = document.querySelector(".pdf-viewer"); return v ? "viewer says: " + (v.querySelector(".pdf-load-error")?.innerText || "(nothing)").replace(/\s+/g, " ").slice(0, 100) : "no viewer opened"; },
  "pdf: relative path (Ctrl+P)": async () => { S.answer = "notes.pdf"; neutral(); key("Control+p"); await sleep(2500); const v = document.querySelector(".pdf-viewer"); return v ? "viewer says: " + (v.querySelector(".pdf-load-error")?.innerText || "(nothing)").replace(/\s+/g, " ").slice(0, 100) : "no viewer opened"; },
  "navigate: page title that does not exist": async () => { const n = (await pages()).length; T.navigateTo("No Such Page 7731"); await sleep(1500); return "current: \"" + T.getCurrentPage() + "\"; pages " + n + "→" + (await pages()).length; },
  "navigate: mistyped title (trailing space)": async () => { const n = (await pages()).length; T.navigateTo("Project Alpha "); await sleep(1500); return "current: \"" + T.getCurrentPage() + "\"; pages " + n + "→" + (await pages()).length; },
  "navigate: unknown page id": async () => { const before = T.getCurrentPage(); T.navigateTo("01234567-89ab-7def-8123-456789abcdef"); await sleep(1500); return "current: \"" + T.getCurrentPage() + "\" (was \"" + before + "\")"; },
  "navigate: click a [[link]] to a missing page": async () => { await nav("Project Alpha"); T.setBlockContent(0, "see [[Ghost Page 55]]"); await sleep(900); const n = (await pages()).length; const l = document.querySelector(".block .ProseMirror [data-type=wikiLink], .block .ProseMirror .wiki-link, .block .ProseMirror a"); if (!l) return "no link rendered"; l.click(); await sleep(1500); return "current: \"" + T.getCurrentPage() + "\"; pages " + n + "→" + (await pages()).length; },
  "journal: impossible date": async () => { const before = T.getCurrentPage(); T.openJournal("2026-13-45"); await sleep(1500); return "current: \"" + T.getCurrentPage() + "\" (was \"" + before + "\"); pending view: " + !!document.querySelector(".pending-journal"); },
  "journal: garbage date": async () => { const before = T.getCurrentPage(); T.openJournal("not-a-date"); await sleep(1500); return "current: \"" + T.getCurrentPage() + "\"; pending view text: " + (document.querySelector(".pending-journal")?.innerText || "").replace(/\s+/g, " ").slice(0, 60); },
  "search: \"": async () => palette("\""),
  "search: *": async () => palette("*"),
  "search: (": async () => palette("("),
  "search: AND": async () => palette("AND"),
  "search: foo:bar": async () => palette("content:alpha"),
  "search: alpha-beta (hyphen)": async () => palette("local-first"),
  "search: %": async () => palette("%"),
  "search: 500 characters": async () => palette("x".repeat(500)),
  "search: emoji": async () => palette("\u{1F680}\u{1F4DD}"),
  "search: known word in quotes": async () => palette("\"Project Alpha\""),
  "rename: title → an existing title": async () => { await api.createPage("Rename Src"); await nav("Rename Src"); const r = await titleRename("Project Alpha"); return r + "; pages titled Project Alpha: " + (await count("Project Alpha")) + ", Rename Src: " + (await count("Rename Src")); },
  "rename: title → empty": async () => { await nav("Rename Src"); return titleRename("   "); },
  "rename: title → 600 characters": async () => { await api.createPage("Rename Long"); await nav("Rename Long"); const r = await titleRename("L".repeat(600)); return r.slice(0, 60) + "…; stored title length: " + ((await pages()).find((p) => p.title.startsWith("LLLL"))?.title.length || "not renamed"); },
  "rename: title → contains /": async () => { await api.createPage("Rename Slash"); await nav("Rename Slash"); return titleRename("a/b/../c"); },
  "create: empty title": async () => sidebarCreate(""),
  "create: whitespace title": async () => sidebarCreate("    "),
  "create: 600-character title": async () => sidebarCreate("T".repeat(600)),
  "create: title with slashes": async () => sidebarCreate("folder/sub/../page"),
  "create: title that already exists": async () => { const r = await sidebarCreate("Project Alpha"); return r + "; pages titled Project Alpha: " + (await count("Project Alpha")); },
  "create: title Journal/2026-01-01": async () => sidebarCreate("Journal/2026-01-01"),
  "create: folder with an existing name": async () => { await api.createFolder("Dup Folder"); T.refreshSidebar(); await sleep(500); document.querySelector(".sidebar-new-project").click(); await until(() => document.querySelector("input[placeholder^=Project]")); const i = document.querySelector("input[placeholder^=Project]"); i.focus(); S.fill(i, "Dup Folder"); key("Enter"); await sleep(1200); const t = await api.getFolderTree(); const open = !!document.querySelector("input[placeholder^=Project]"); if (open) { document.querySelector("input[placeholder^=Project]").focus(); key("Escape"); } return "folders named Dup Folder: " + t.folders.filter((f) => f.name === "Dup Folder").length + (open ? "; input stayed open" : ""); },
  "delete: edit a page after it was trashed": async () => { const p = await api.createPage("Doomed"); await api.createBlock(p.id, "still here"); await nav("Doomed"); await api.trashPage(p.id); T.refreshSidebar(); await sleep(600); T.setBlockContent(0, "edited after delete"); await sleep(1500); let saved = "?"; try { saved = (await api.getPageTree(p.id)).blocks.map((b) => b.content).join("|"); } catch (e) { saved = "getPageTree rejects: " + e; } return "still showing \"" + T.getCurrentPage() + "\"; stored: " + String(saved).slice(0, 60); },
  "delete: open a trashed page by title": async () => { const n = (await pages()).length; T.navigateTo("Doomed"); await sleep(1500); return "current: \"" + T.getCurrentPage() + "\", blocks " + T.getBlockCount() + "; pages " + n + "→" + (await pages()).length; },
  "delete: edit a page after permanent delete": async () => { const p = await api.createPage("Gone Forever"); await api.createBlock(p.id, "x"); await nav("Gone Forever"); await api.trashPage(p.id); await api.permanentlyDelete(p.id, "page"); T.refreshSidebar(); await sleep(600); T.setBlockContent(0, "typed into a deleted page"); await sleep(1500); return "still showing \"" + T.getCurrentPage() + "\" with " + T.getBlockCount() + " block(s)"; },
  "delete: press Enter in a permanently deleted page": async () => { T.pressEnterInBlock && T.pressEnterInBlock(0); await sleep(1500); return "blocks shown: " + T.getBlockCount(); },
  "rapid: 25 navigations in one tick": async () => { const names = ["Project Alpha", "Research Notes", "Getting Started"]; for (let i = 0; i < 25; i++) T.navigateTo(names[i % 3]); T.navigateTo("Research Notes"); await sleep(2500); return "landed on \"" + T.getCurrentPage() + "\" (expected Research Notes), " + T.getBlockCount() + " blocks"; },
  "rapid: open/close every panel quickly": async () => { neutral(); for (const k of ["Control+k", "Control+,", "Control+q", "Control+r", "Control+g", "Control+m", "Control+Shift+K", "Control+k"]) { key(k); await sleep(60); } await sleep(1500); const r = "open: " + ["search", "query", "review", "settings", "graph"].filter((p) => T.isPanelOpen(p)).join(",") + "; canvas: " + !!document.querySelector(".canvas-layer"); return r; },
  "query: invalid SQL": async () => { neutral(); if (!T.isPanelOpen("query")) key("Control+q"); await until(() => document.querySelector(".query-input")); const i = document.querySelector(".query-input"); S.fill(i, "SELEC nonsense FROM"); S.byText(".query-actions button", "").click(); await sleep(1200); return "panel says: " + (document.querySelector(".query-error")?.innerText || "(nothing)").slice(0, 100); },
  "query: write statement": async () => { neutral(); if (!T.isPanelOpen("query")) key("Control+q"); await until(() => document.querySelector(".query-input")); const i = document.querySelector(".query-input"); S.fill(i, "DELETE FROM pages"); S.byText(".query-actions button", "").click(); await sleep(1200); return "panel says: " + (document.querySelector(".query-error")?.innerText || "(nothing)").slice(0, 100) + "; pages left: " + (await pages()).length; },
  "content: image that does not exist": async () => { await api.createPage("Odd Content"); await nav("Odd Content"); T.setBlockContent(0, "![missing](/no/such/image.png)"); await sleep(1500); const im = document.querySelector(".block img"); return im ? "img rendered, naturalWidth " + im.naturalWidth + ", alt \"" + im.alt + "\"" : "no img element"; },
  "content: remote image": async () => { await nav("Odd Content"); T.setBlockContent(0, "![remote](https://example.invalid/pic.png)"); await sleep(2500); const im = document.querySelector(".block img"); return im ? "img rendered, naturalWidth " + im.naturalWidth : "no img element"; },
  "content: whiteboard that does not exist": async () => { await nav("Odd Content"); T.setBlockContent(0, "{{whiteboard:wb-missing-123}}"); await sleep(1200); const w = document.querySelector(".whiteboard-indicator"); if (!w) return "no indicator rendered"; w.click(); await sleep(1500); return "opened canvas: " + !!document.querySelector("canvas"); },
  "content: block ref to a missing block": async () => { await nav("Odd Content"); T.setBlockContent(0, "see ((01234567-89ab-7def-8123-456789abcdef))"); await sleep(1500); return "block shows: " + (document.querySelector(".block .ProseMirror")?.innerText || "").trim().slice(0, 60); },
  "content: raw HTML / script": async () => { await nav("Odd Content"); T.setBlockContent(0, "<img src=x onerror=window.__pwned=1> <script>window.__pwned=2</script>"); await sleep(1500); return "script ran: " + (window.__pwned !== undefined) + "; block shows: " + (document.querySelector(".block .ProseMirror")?.innerText || "").trim().slice(0, 50); },
  "content: PDF link to a missing file": async () => { await nav("Odd Content"); T.setBlockContent(0, "[paper](/no/such/paper.pdf)"); await sleep(1000); const a = document.querySelector(".block .ProseMirror a"); if (!a) return "no link rendered"; a.click(); await sleep(2500); const v = document.querySelector(".pdf-viewer"); return v ? "viewer says: " + (v.querySelector(".pdf-load-error")?.innerText || "(nothing)").replace(/\s+/g, " ").slice(0, 80) : "nothing opened"; },
  "property: add with an empty key": async () => { await nav("Project Alpha"); const b = document.querySelector(".prop-toggle-btn"); if (b && !document.querySelector(".page-properties, [class*=prop-panel], [class*=page-info]")) b.click(); await sleep(500); const add = S.byText("button", "Add property") || S.byText("button", "+ Add"); if (!add) return "no add-property control found"; add.click(); await sleep(400); const ins = [...document.querySelectorAll("input[placeholder=key], input[placeholder=value]")]; if (!ins.length) return "no key input"; ins[0].focus(); S.fill(ins[0], ""); key("Enter"); await sleep(900); return "inputs still open: " + !!document.querySelector("input[placeholder=key]"); },
  "sync panel: open with no remote": async () => { await cmd("Sync"); await sleep(600); const p = document.querySelector("[class*=sync-panel], .command-palette-overlay"); return p ? p.innerText.replace(/\s+/g, " ").slice(0, 100) : "no panel"; },
};
return Object.keys(window.__scn);
