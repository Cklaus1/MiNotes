/**
 * Browser-mode mock of the import + attachment commands (real ones:
 * src-tauri/src/import_commands.rs). It imports a small canned source — any
 * folder path is "an Obsidian vault" (or a markdown folder), any .enex path
 * "an Evernote notebook" — through the ordinary mock page/block handlers, so
 * the dialog's whole flow (scan, preview, import, report, undo) runs in the
 * browser journeys.
 */
import { registerMockAttachmentUrl, type Attachment } from "./attachments";

type H = Record<string, (args: any) => any>;

// A small "diagram.png" (so the imported image renders in browser mode too).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAADf0lEQVR42u3dW0hTcRzA8d+ZZ5rmpAzKgkrNoJvdLwTlQ0X0WFRUaARJj12eSrpB9JAPEVnRU0SRJV0oguhqVFKa0WWMnNkFy6VOy2OZuuYup4fJSTe3Eru5vp8n8f/T/zxf/schbCrjNj0URC8Tl4DA6MdU46PKgjlcjqgxfnM5J5hbNKLpFh16utHvhP6e5QRziwaBQWAQGAQGgUFgAoPAIDAIDAKDwCAwgUFgEBgEBoFBYBAYBCYwCAwCg8AgMAiMXxX4Uf5MEclIiV8zbxgX8V+m9uWLXztdr50uLmKUBB5iMe9dnZaUoDo+urse5dl5jzNS4vesSktKUC+UNZ686zQmazV31vhBc7c/CUwW27TK2vayqs9dhwNLt2zarIyk47frpqdbpqVZCkucgSVjl/NljVNSE0WXvNNv3je5H+XPPHO/YUa6xRIfc+Ta+2Jbc4+bohe36K1LR117puUU2IttWpxZ6bqUnZVy4Iojp8Ceu3BE18mbVi0hrnOLWFW5+rTp1D1n0LCIxJmVsw8a1x22716ZVljSsO5IpbFkfO3zmracAvu50sa8ZaNFxKwqza2etYfsG4+93LE8Ndym6MWFmJ2RdMOqicjdik9+f7el/Zdr0ofGb1g0InFATLhJvy6lVZ9DhwNLFY62+uYOj8//vKa1TnMPMHd7YLpIsU0TketWbWpqooiYFLlY/kFEHE3uCJuiF4HNMZ2n1qSIdDvAcnD9WBEpLHH6dT3cpNen+/UehkXE49V9fl1E3J7OmSC6LsbnO7y6iHh8+heXz1iN/PAI/FOsb1sXZg4WkUWTk4Mu4KSRA69bm2JVU6xqijwZOhxBQlznEY8xSdaEQSKyZGpy+asWEQk9o5E35UnWj+VfepefPSZ7/rBn1V8Cx8hQdL+haMvEF7XtLe3eWNVkTFrftro6glMEDXd4w95PD+eOzT36InCyF09Jzl0wvMXl3VlUHfnh9bjpf0sx3qvSeIOWvr/Lzr7sMSfu1FfVtWeOGrht6eicQ/Y+fsPAc/U/vGl/FBpR/R3bFJY4d61I/erxm1Vlz/nqP/Oz/ZVNo/wPHeFUONp+7QH64fH9HZv+d0+yQGAQGAQGgUFgEJjAIDAIDAKDwCAwCExgEBgEBoFBYBAYBCYwCAwCg8AgMAiM3ujhtUmh/wcenGAQGH/D9xeAgxMMAuMf8w3Yko0fNoQlxQAAAABJRU5ErkJggg==";

const attachments = new Map<string, Attachment>();

async function sha256(bytes: Uint8Array): Promise<string> {
  try {
    const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Non-secure context: a stable non-cryptographic stand-in.
    let h1 = 0x811c9dc5, out = "";
    for (let r = 0; r < 8; r++) {
      for (const b of bytes) h1 = Math.imul(h1 ^ b ^ r, 16777619) >>> 0;
      out += h1.toString(16).padStart(8, "0");
    }
    return out;
  }
}

async function store(name: string, mime: string, bytes: Uint8Array): Promise<Attachment> {
  const hash = await sha256(bytes);
  const existing = attachments.get(hash);
  if (existing) return existing;
  const ext = (name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "bin";
  const a: Attachment = { hash, name, mime: mime || (ext === "png" ? "image/png" : "application/octet-stream"), ext, size: bytes.length, created_at: new Date().toISOString() };
  attachments.set(hash, a);
  registerMockAttachmentUrl(hash, URL.createObjectURL(new Blob([bytes as BlobPart], { type: a.mime })));
  return a;
}

function encodeName(name: string) {
  return Array.from(new TextEncoder().encode(name))
    .map((b) => (/[A-Za-z0-9._~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0")))
    .join("");
}

interface MockNote { title: string; folder: string | null; body: string[]; journal?: string; src: string }

function cannedSource(kind: string, name: string): { notes: MockNote[]; folders: string[] } {
  if (kind === "evernote") {
    return {
      folders: [name],
      notes: [
        { title: "Packing list", folder: name, body: ["Things to pack:", "- [x] Passport", "- [ ] Sunscreen"], src: "<div><en-todo checked=\"true\"/>Passport</div>" },
        { title: "Trip photos", folder: name, body: ["The beach:", "@@IMG@@"], src: "<en-media hash=\"…\" type=\"image/png\"/>" },
        { title: "Itinerary", folder: name, body: ["# Day one", "  Arrive at **noon**", "  See [[Packing list]]"], src: "<h1>Day one</h1>…" },
      ],
    };
  }
  return {
    folders: ["Projects"],
    notes: [
      { title: "Home", folder: null, body: ["# Welcome to the vault", "  Links to [[Alpha]] and [[Beta]]", "  @@IMG@@", "  - [ ] An imported task"], src: "# Welcome to the vault\nLinks to [[Alpha]]…\n![[diagram.png]]" },
      { title: "Alpha", folder: "Projects", body: ["# Alpha", "  Back to [[Home]]", "  - Milestone 1"], src: "# Alpha\nBack to [[Home]]" },
      { title: "Beta", folder: null, body: ["Beta note with a [[Missing Note]] link"], src: "Beta note with a [[Missing Note]] link" },
      { title: "Journal/2024-01-15", folder: null, journal: "2024-01-15", body: ["Daily note: worked on [[Alpha]]"], src: "Daily/2024-01-15.md" },
    ],
  };
}

let scanned: { kind: string; name: string } | null = null;
const runs: { id: string; pages: string[]; folders: string[]; hashes: Map<string, string>; status: string; started_at: string; source: string; notebook: string }[] = [];

function progress(phase: string, done: number, total: number, current = "") {
  window.dispatchEvent(new CustomEvent("minotes-import-progress", { detail: { phase, done, total, current } }));
}

function previewOf(kind: string, name: string, options: any) {
  const { notes, folders } = cannedSource(kind, name);
  const pages = notes.map((n) => ({ name: n.title, kind: n.journal ? "journal" : "page", children: [], more: 0 }));
  const tree = [{
    name, kind: "project", more: 0,
    children: [
      ...folders.map((f) => ({ name: f, kind: "project", more: 0, children: pages.filter((_, i) => notes[i].folder === f) })),
      ...pages.filter((_, i) => notes[i].folder === null),
    ],
  }];
  const split = (options?.split ?? "outline") as string;
  const samples = notes.slice(0, 3).map((n) => ({
    title: n.title,
    source_path: kind === "evernote" ? `${name}.enex#${n.title}` : `${n.folder ? n.folder + "/" : ""}${n.title}.md`,
    source: n.src,
    blocks: split === "note"
      ? [{ depth: 0, content: n.body.map((l) => l.trim()).join("\n").replace("@@IMG@@", "![diagram.png](attachment:…/diagram.png)") }]
      : n.body.map((l) => ({ depth: (l.length - l.trimStart().length) / 2, content: l.trim().replace("@@IMG@@", "![diagram.png](attachment:…/diagram.png)") })),
  }));
  const warnings = kind === "evernote"
    ? [{ category: "en_crypt", label: "encrypted Evernote text — kept as an opaque block", count: 1, notes: ["Secret"], examples: [] }]
    : [
        { category: "dataview", label: "Dataview queries — kept as code", count: 2, notes: ["Home.md"], examples: [] },
        { category: "unresolved_link", label: "links to notes that aren't in the import — kept as [[links]]", count: 1, notes: ["Beta.md"], examples: ["Missing Note"] },
      ];
  return {
    source: kind, source_label: kind === "evernote" ? "Evernote export" : kind === "obsidian" ? "Obsidian vault" : "Markdown folder",
    source_name: name,
    counts: { notes: notes.length, pages: notes.length, journals: notes.filter((n) => n.journal).length, folders: folders.length, attachments: 1, attachment_bytes: 152, total_bytes: 4096, skipped: 0, reimport: 0 },
    tree, samples, warnings, title_mappings: [],
  };
}

export function createImportMockHandlers(m: H): H {
  const contentOf = (pageId: string) =>
    (m.get_page_tree({ titleOrId: pageId }).blocks as { content: string }[]).map((b) => b.content).join("\n");
  return {
    store_attachment: ({ name, mime, bytes }: { name: string; mime: string; bytes: Uint8Array }) => store(name, mime, bytes),
    store_dropped_files: () => [],
    open_attachment: () => undefined,
    get_attachment: ({ hash }: { hash: string }) => attachments.get(hash) ?? null,
    import_detect: ({ path }: { path: string }) => ({
      kind: /\.enex$/i.test(path) ? "evernote" : /markdown|md-folder/i.test(path) ? "markdown" : "obsidian",
      name: path.split("/").filter(Boolean).pop()?.replace(/\.enex$/i, "") ?? "Import",
    }),
    import_scan: async ({ kind, paths, options }: { kind: string; paths: string[]; options: any }) => {
      if (!paths?.length) throw "Choose what to import";
      const name = paths[0].split("/").filter(Boolean).pop()!.replace(/\.enex$/i, "");
      for (let i = 0; i <= 4; i++) {
        progress("scan", i, 4, `note ${i}`);
        await new Promise((r) => setTimeout(r, 30));
      }
      scanned = { kind, name };
      return previewOf(kind, name, options);
    },
    import_preview: ({ options }: { options: any }) => {
      if (!scanned) throw "Scan a source first";
      return previewOf(scanned.kind, scanned.name, options);
    },
    import_discard: () => { scanned = null; },
    import_cancel: () => undefined,
    import_run: async ({ destination, options }: { destination: any; options: any }) => {
      if (!scanned) throw "Scan a source first";
      const { kind, name } = scanned;
      const original = m.get_current_notebook({});
      let notebookKey: string | null = null;
      let notebookName: string | null = null;
      if (destination.kind === "new_notebook") {
        const existing = (m.list_notebooks({}) as { name: string }[]).map((n) => n.name);
        let nbName = destination.name || name;
        for (let i = 2; existing.includes(nbName); i++) nbName = `${destination.name || name} ${i}`;
        const nb = m.create_notebook({ name: nbName });
        notebookKey = nb.key;
        notebookName = nb.name;
        m.switch_notebook({ key: nb.key });
      }
      const runId = `run-${Date.now().toString(36)}`;
      const run = { id: runId, pages: [] as string[], folders: [] as string[], hashes: new Map<string, string>(), status: "done", started_at: new Date().toISOString(), source: kind, notebook: notebookKey ?? original };
      try {
        const img = await store("diagram.png", "image/png", Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0)));
        const { notes, folders } = cannedSource(kind, name);
        let top: string | null = null;
        if (destination.kind === "current") {
          const f = m.create_folder({ name: destination.project || `Imported from ${name} (${new Date().toISOString().slice(0, 10)})` });
          top = f.id; run.folders.push(f.id);
        }
        const folderIds = new Map<string, string>();
        for (const f of folders) {
          const created = m.create_folder({ name: f, parentId: top });
          folderIds.set(f, created.id); run.folders.push(created.id);
        }
        let i = 0;
        for (const n of notes) {
          progress("import", ++i, notes.length, n.title);
          let title = n.title;
          for (let k = 2; (m.list_pages({ limit: 100000 }) as { title: string }[]).some((p) => p.title.toLowerCase() === title.toLowerCase()); k++) title = `${n.title} (${k})`;
          const page = m.create_page({ title });
          const folder = n.folder ? folderIds.get(n.folder) : top;
          if (folder) m.move_page_to_folder({ pageId: page.id, folderId: folder });
          const stack: { depth: number; id: string }[] = [];
          for (const raw of n.body) {
            const depth = (raw.length - raw.trimStart().length) / 2;
            const content = raw.trim().replace("@@IMG@@", `![diagram.png](attachment:${img.hash}/${encodeName(img.name)})`);
            while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
            const b = m.create_block({ pageId: page.id, content, parentId: stack.length ? stack[stack.length - 1].id : null });
            stack.push({ depth, id: b.id });
          }
          for (const [k, v] of [["import_source", kind], ["import_ref", n.src], ["import_run", runId]]) {
            m.set_property({ entityId: page.id, entityType: "page", key: k, value: v, valueType: "text" });
          }
          run.pages.push(page.id);
          run.hashes.set(page.id, contentOf(page.id));
          await new Promise((r) => setTimeout(r, 20));
        }
        const date = new Date().toISOString().slice(0, 10);
        let rtitle = `Import report — ${date}`;
        for (let k = 2; (m.list_pages({ limit: 100000 }) as { title: string }[]).some((p) => p.title === rtitle); k++) rtitle = `Import report — ${date} (${k})`;
        const report = m.create_page({ title: rtitle });
        if (top) m.move_page_to_folder({ pageId: report.id, folderId: top });
        m.create_block({ pageId: report.id, content: `Imported **${name}** (${kind})` });
        const warnings = previewOf(kind, name, options).warnings;
        const h = m.create_block({ pageId: report.id, content: "## What didn't convert cleanly" });
        for (const w of warnings) m.create_block({ pageId: report.id, parentId: h.id, content: `**${w.count}** ${w.label}` });
        m.set_property({ entityId: report.id, entityType: "page", key: "import_run", value: runId, valueType: "text" });
        run.pages.push(report.id);
        run.hashes.set(report.id, contentOf(report.id));
        runs.unshift(run);
        scanned = null;
        return {
          run_id: runId, source: kind, source_name: name, status: "done",
          pages_created: notes.length, journals_created: 0, folders_created: run.folders.length, blocks_created: 0,
          attachments_created: 1, attachments_reused: 0, attachment_bytes: img.size,
          pages_updated: 0, pages_unchanged: 0, reimported_copies: 0, skipped: 0,
          warnings: warnings.map((w) => ({ category: w.category, label: w.label, count: w.count, pages: w.notes.map((t) => [t, null]), examples: w.examples })),
          report_page_id: report.id, report_page_title: report.title, duration_ms: 120,
          notebook_key: notebookKey, notebook_name: notebookName,
        };
      } finally {
        if (notebookKey) m.switch_notebook({ key: original });
      }
    },
    import_undo: ({ runId, keepEdited }: { runId: string; keepEdited?: boolean }) => {
      const run = runs.find((r) => r.id === runId);
      if (!run) throw `Not found: Import run ${runId}`;
      const live = new Set((m.list_pages({ limit: 100000 }) as { id: string }[]).map((p) => p.id));
      const edited = run.pages.filter((id) => live.has(id) && contentOf(id) !== run.hashes.get(id))
        .map((id) => ({ id, title: m.get_page_tree({ titleOrId: id }).page.title }));
      const base = { run_id: runId, pages_deleted: 0, folders_deleted: 0, attachments_deleted: 0, edited, updated_kept: 0 };
      if (edited.length && !keepEdited) return { ...base, undone: false };
      const keep = new Set(edited.map((e) => e.id));
      for (const id of run.pages) if (live.has(id) && !keep.has(id)) { m.delete_page({ id }); base.pages_deleted++; }
      for (const id of [...run.folders].reverse()) {
        try { m.delete_folder({ id }); base.folders_deleted++; } catch { /* already gone */ }
      }
      run.status = edited.length ? "partially_undone" : "undone";
      return { ...base, undone: true };
    },
    import_runs: () => runs.filter((r) => r.notebook === m.get_current_notebook({})).map((r) => ({
      id: r.id, source: r.source, origin: "", source_path: "", started_at: r.started_at, finished_at: r.started_at, status: r.status, report_page: r.pages[r.pages.length - 1], pages: r.pages.length,
    })),
  };
}
