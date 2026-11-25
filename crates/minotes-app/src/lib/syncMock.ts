/**
 * Browser-mode mock of sync setup, conflict compare and held deletions
 * (src-tauri sync_commands.rs; core sync_remote.rs, repo/conflicts.rs). Like
 * the real backend it refuses `ext::` / option / password addresses, says what
 * "Test connection" found, sets up / changes / removes the remote, joins a
 * plain or an encrypted notebook, compares a "(conflict from …)" copy with its
 * page by aligning the two outlines on equal text (the real backend pairs
 * blocks by derived ids, falling back to the same alignment), and resolves it
 * as one step. Remotes are simulated: journeys fill `mockRemotes.remotes`.
 */
import { mockSync } from "./mockBackend";

type H = Record<string, (args: any) => any>;

function fail(msg: string): never {
  throw msg;
}

interface MockRemote {
  /** What Test connection finds there. */
  status: "reachable" | "empty" | "not_found" | "auth" | "not_a_repo" | "offline" | "timeout";
  /** For join: the notebook it holds. */
  pages?: { title: string; blocks: string[] }[];
  /** An encrypted notebook's remote: joining needs this passphrase. */
  passphrase?: string;
}

/** Simulated remotes by address, held deletions, the next picked folder. */
export const mockRemotes: {
  remotes: Record<string, MockRemote>;
  held: { pages: number; journals: number; folders: number; titles: string[]; total_pages: number; items: { id: string; title: string; kind: string }[] } | null;
  nextPicked: string | null | undefined;
} = { remotes: {}, held: null, nextPicked: undefined };

const MESSAGES: Record<string, string> = {
  not_found: "Not found — no git repository at that address (moved, deleted, mistyped — or private and you're not signed in)",
  auth: "Sign-in refused. MiNotes uses your computer's git setup: check your SSH key (and ssh-agent) or git's credential helper for this server",
  not_a_repo: "Something answers at that address, but it isn't a git repository",
  offline: "Can't reach the server — check the address and your network",
  timeout: "No answer from the server in time — check the address and your network",
};

/** core `validate_remote` (the rules that matter in the UI). */
function validate(raw: string): { url: string; local: boolean } {
  const s = (raw ?? "").trim();
  if (!s) fail("Enter the address of the git repository");
  if (/[\u0000-\u001f\u007f]/.test(s)) fail("The address contains a control character");
  if (s.startsWith("-")) fail("An address can't start with “-”");
  const helper = /^([A-Za-z0-9+.-]+)::/.exec(s);
  if (helper) fail(`“${helper[1]}::” addresses run a program on this computer — not allowed. Use https://, ssh:// or user@host:path`);
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (scheme) {
    const k = scheme[1].toLowerCase();
    if (k === "file") return validateLocal(scheme[2]);
    if (k === "git") fail("git:// addresses can't receive pushes — use the ssh:// or https:// address of the repository");
    if (!["https", "http", "ssh", "git+ssh", "ssh+git"].includes(k)) fail(`“${k}://” is not a supported address type — use https://, ssh:// or user@host:path`);
    if (/\s/.test(s)) fail("A web or SSH address can't contain spaces");
    const authority = scheme[2].split("/")[0];
    if (authority.includes("@") && authority.slice(0, authority.lastIndexOf("@")).includes(":")) {
      fail("Don't put a password or token in the address: MiNotes would have to store it. Remove it — git signs in with your credential helper or SSH key");
    }
    if (!scheme[2].split("/").slice(1).join("/").replace(/\//g, "")) fail("The address needs the repository's path (…/owner/notes.git)");
    return { url: s, local: false };
  }
  const scp = /^([^/\\:]{2,}):(.*)$/.exec(s);
  if (scp) {
    if (!scp[2].replace(/\//g, "")) fail("The address needs the repository's path (git@host:owner/notes.git)");
    return { url: s, local: false };
  }
  return validateLocal(s);
}

const HOME = "/home/user";
/** Folders chosen with "Choose folder…" (allowed outside home, like the app). */
const pickedFolders = new Set<string>();

function validateLocal(p: string): { url: string; local: boolean } {
  const path = p === "~" ? HOME : p.startsWith("~/") ? `${HOME}/${p.slice(2)}` : p;
  if (!path.startsWith("/")) fail("Enter a web address (https://…), an SSH address (user@host:path) or a full folder path");
  if (path.split("/").includes("..")) fail("The folder path must not contain “..”");
  const inHome = path.startsWith(`${HOME}/`) && !path.slice(HOME.length + 1).startsWith(".");
  if (!inHome && !pickedFolders.has(path)) {
    fail("That folder is outside your home folder (or in a hidden one). Choose it with “Choose folder…” to use it anyway");
  }
  return { url: path, local: true };
}

function check(raw: string) {
  let v: { url: string };
  try { v = validate(raw); } catch (e) {
    return { status: "invalid", message: String(e), branches: [], default_branch: null, warning: null, url: (raw ?? "").trim() };
  }
  const r = mockRemotes.remotes[v.url];
  const status = r?.status ?? "not_found";
  if (status === "empty") return { status, message: "Reachable — an empty repository. “Set up sync” sends this notebook there", branches: [], default_branch: null, warning: null, url: v.url };
  if (status === "reachable") return { status, message: "Reachable — it already holds notes (1 branch: main)", branches: ["main"], default_branch: "main", warning: null, url: v.url };
  return { status, message: MESSAGES[status], branches: [], default_branch: null, warning: null, url: v.url };
}

function usable(raw: string): string {
  const c = check(raw);
  if (c.status === "invalid") fail(c.message);
  if (c.status !== "reachable" && c.status !== "empty") fail(c.message);
  return c.url;
}

// ── Conflict copies (core repo/conflicts.rs, alignment path) ──

interface B { id: string; page_id: string; parent_id?: string | null; content: string; position: number }

export function parseConflictTitle(title: string): [string, string] | null {
  const m = /^(.+) \(conflict from (.+?)\)(?: \(\d+\))?$/.exec(title.trimEnd());
  return m ? [m[1], m[2]] : null;
}

const norm = (s: string) => s.replace(/\r\n?/g, "\n").split("\n").map(l => l.trimEnd()).join("\n").trim();

function depths(bs: B[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const b of bs) d.set(b.id, b.parent_id && d.has(b.parent_id) ? d.get(b.parent_id)! + 1 : 0);
  return d;
}

function rowOf(m: B | null, t: B | null, md: Map<string, number>, td: Map<string, number>) {
  return {
    key: `${m?.id ?? ""}|${t?.id ?? ""}`,
    mine: m ? { block_id: m.id, content: m.content, depth: md.get(m.id) ?? 0 } : null,
    theirs: t ? { block_id: t.id, content: t.content, depth: td.get(t.id) ?? 0 } : null,
  };
}

function align(mine: B[], theirs: B[]) {
  const a = mine.map(b => norm(b.content)), b = theirs.map(x => norm(x.content));
  const n = a.length, m = b.length;
  const l: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) l[i][j] = a[i] === b[j] ? l[i + 1][j + 1] + 1 : Math.max(l[i + 1][j], l[i][j + 1]);
  const md = depths(mine), td = depths(theirs);
  const rows: ReturnType<typeof rowOf>[] = [];
  let i = 0, j = 0, ga: number[] = [], gb: number[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(ga.length, gb.length); k++) rows.push(rowOf(ga[k] !== undefined ? mine[ga[k]] : null, gb[k] !== undefined ? theirs[gb[k]] : null, md, td));
    ga = []; gb = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < m && (i >= n || l[i][j + 1] >= l[i + 1][j])) gb.push(j++);
    else ga.push(i++);
  }
  flush();
  return rows;
}

export function createSyncMockHandlers(h: H): H {
  const baseSync = h.git_sync;
  const baseResolve = h.git_sync_resolve_deletions;
  const baseEnable = h.git_sync_enable;
  /** Notebooks made by a join: their remote's notes arrive when sync turns on. */
  const joined = new Map<string, { url: string; pages: { title: string; blocks: string[] }[] }>();

  /** Turn sync on; with a remote, the first push reaches it ("Last synced"). */
  const enable = () => {
    const j = joined.get(h.get_current_notebook({}));
    if (j) {
      joined.delete(h.get_current_notebook({}));
      mockSync.remote_url = j.url;
      for (const p of j.pages) {
        const page = h.create_page({ title: p.title });
        for (const t of p.blocks) h.create_block({ pageId: page.id, content: t });
      }
    }
    const s = baseEnable({});
    if (!mockSync.remote_url) return s;
    if (mockSync.fail) {
      Object.assign(mockSync, { last_error: mockSync.fail.error, last_error_kind: mockSync.fail.kind });
    } else {
      Object.assign(mockSync, { last_sync: new Date().toISOString(), last_error: null, last_error_kind: null });
    }
    return h.git_sync_status({});
  };
  const tree = (id: string) => h.get_page_tree({ titleOrId: id }) as { page: { id: string; title: string }; blocks: B[] };
  const compare = (copyId: string) => {
    const copy = tree(copyId);
    const parsed = parseConflictTitle(copy.page.title);
    if (!parsed) fail(`Invalid input: “${copy.page.title}” is not a sync conflict copy`);
    const [base, device] = parsed!;
    let page: { page: { id: string; title: string }; blocks: B[] } | null = null;
    try { page = tree(base); } catch { page = null; }
    if (page && page.page.id === copyId) page = null;
    const trashed = page ? (h.list_trash({}) as { id: string }[]).some(t => t.id === page!.page.id) : false;
    const rows = page ? align(page.blocks, copy.blocks) : align([], copy.blocks);
    return {
      copy_id: copyId, copy_title: copy.page.title, device,
      page_id: page?.page.id ?? null, page_title: page?.page.title ?? null, page_trashed: trashed,
      rows, exact: false,
    };
  };
  const snapshot = (pageId: string) => tree(pageId).blocks.map(b => ({
    id: b.id, page_id: b.page_id, parent_id: b.parent_id ?? null, content: b.content, position: b.position, properties: [],
  }));
  const placeAfter = (newId: string, after: B) => {
    const siblings = tree(after.page_id).blocks.filter(s => (s.parent_id ?? null) === (after.parent_id ?? null) && s.id !== newId).sort((x, y) => x.position - y.position);
    const i = siblings.findIndex(s => s.id === after.id);
    const next = siblings[i + 1];
    h.reorder_block({ id: newId, parentId: after.parent_id ?? undefined, position: next ? (after.position + next.position) / 2 : after.position + 1 });
  };

  return {
    git_sync_test_remote: ({ url }: { url: string }) => check(url),
    git_sync_setup: ({ url }: { url: string }) => {
      const u = usable(url);
      if (mockSync.remote_url) fail("Invalid input: This notebook already has a sync remote — change it instead");
      mockSync.remote_url = u;
      return enable();
    },
    git_sync_set_remote: ({ url }: { url: string }) => {
      const u = usable(url);
      Object.assign(mockSync, { remote_url: u, last_sync: null, last_error: null, last_error_kind: null });
      return h.git_sync_status({});
    },
    git_sync_remove_remote: () => {
      Object.assign(mockSync, { remote_url: null, last_sync: null, last_error: null, last_error_kind: null });
      return h.git_sync_status({});
    },
    pick_sync_remote_folder: () => {
      const p = mockRemotes.nextPicked;
      mockRemotes.nextPicked = undefined;
      if (p) pickedFolders.add(p);
      return p ?? null;
    },
    git_sync_enable: () => enable(),
    join_notebook: ({ remote, name, location, passphrase }: { remote: string; name: string; location?: string | null; passphrase?: string | null }) => {
      const c = check(remote);
      if (c.status === "invalid") fail(c.message);
      if (c.status === "empty") fail("That repository is empty — there is no notebook to join yet. On the device that has the notes, use Settings → Sync & Backup → Set up sync first");
      if (c.status !== "reachable") fail(c.message);
      const r = mockRemotes.remotes[c.url];
      let nb: { key: string };
      if (r.passphrase !== undefined) {
        if (!passphrase) fail("ENCRYPTED_REMOTE: This notebook is encrypted — enter its passphrase (or recovery key) to join it");
        if (passphrase !== r.passphrase) fail("Wrong passphrase or recovery key");
        nb = h.create_encrypted_notebook({ name, location, passphrase }).notebook;
      } else {
        nb = h.create_notebook({ name, location });
      }
      joined.set(nb.key, { url: c.url, pages: r.pages ?? [] });
      return nb;
    },
    git_sync: () => {
      const r = baseSync({});
      return { ...r, held_deletions: mockRemotes.held };
    },
    git_sync_resolve_deletions: ({ action, keep }: { action: string; keep?: string[] | null }) => {
      const held = mockRemotes.held;
      if (!held) return baseResolve({ action });
      mockRemotes.held = null;
      if (action !== "trash") return 0;
      const k = new Set(keep ?? []);
      let n = 0;
      for (const it of held.items) {
        if (k.has(it.id)) continue;
        if (it.kind === "folder") h.trash_folder({ id: it.id }); else h.trash_page({ id: it.id });
        n++;
      }
      return n;
    },

    conflict_compare: ({ copyId }: { copyId: string }) => compare(copyId),
    resolve_conflict: ({ copyId, choices }: { copyId: string; choices: { key: string; choice: string }[] }) => {
      const cmp = compare(copyId);
      if (!cmp.page_id) fail("Invalid input: The page this copy is a version of is gone — keep the copy as it is, or move it to the Trash");
      const want = new Map(choices.map(c => [c.key, c.choice]));
      for (const c of choices) if (!cmp.rows.some(r => r.key === c.key)) fail(`Invalid input: These versions changed meanwhile (unknown block ${c.key}) — compare again`);
      const missing = cmp.rows.filter(r => !want.has(r.key)).length;
      if (missing) fail(`Invalid input: Choose a version for every block (${missing} left)`);
      const pageId = cmp.page_id!;
      const before = snapshot(pageId);
      let kept_mine = 0, took_theirs = 0, kept_both = 0;
      for (const r of cmp.rows) {
        const c = want.get(r.key);
        if (c === "mine") { kept_mine++; continue; }
        if (c === "theirs") took_theirs++; else kept_both++;
        const mine = r.mine ? tree(pageId).blocks.find(b => b.id === r.mine!.block_id) ?? null : null;
        if (mine && r.theirs && c === "theirs") h.update_block({ id: mine.id, content: r.theirs.content });
        else if (mine && r.theirs && c === "both") { const nb = h.create_block({ pageId, content: r.theirs.content, parentId: mine.parent_id ?? undefined }); placeAfter(nb.id, mine); }
        else if (!mine && r.theirs) h.create_block({ pageId, content: r.theirs.content });
        else if (mine && !r.theirs && c === "theirs") h.delete_block({ id: mine.id });
      }
      h.trash_page({ id: copyId });
      return { page_id: pageId, copy_id: copyId, before, after: snapshot(pageId), kept_mine, took_theirs, kept_both };
    },
    set_conflict_resolution: ({ pageId, copyId, blocks, copyInTrash }: { pageId: string; copyId: string; blocks: { id: string; page_id: string; parent_id: string | null; content: string; position: number; properties: [string, string][] }[]; copyInTrash: boolean }) => {
      const want = new Set(blocks.map(b => b.id));
      const cur = tree(pageId).blocks;
      for (const b of cur) if (!want.has(b.id) && tree(pageId).blocks.some(x => x.id === b.id)) h.delete_block({ id: b.id });
      const have = new Set(tree(pageId).blocks.map(b => b.id));
      const missing = blocks.filter(b => !have.has(b.id));
      if (missing.length) h.restore_blocks({ blocks: missing });
      for (const b of blocks) {
        h.update_block({ id: b.id, content: b.content });
        h.reorder_block({ id: b.id, parentId: b.parent_id ?? undefined, position: b.position });
      }
      const inTrash = (h.list_trash({}) as { id: string }[]).some(t => t.id === copyId);
      if (copyInTrash && !inTrash) h.trash_page({ id: copyId });
      if (!copyInTrash && inTrash) h.restore_from_trash({ id: copyId, itemType: "page" });
    },
  };
}
