import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { mockHandlers } from "./mockBackend";

// Detect if we're running inside Tauri or in a regular browser
const isTauri = !!(window as any).__TAURI_INTERNALS__;

// Unified invoke: uses Tauri when available, mock backend otherwise
async function invoke<T>(command: string, args?: Record<string, any>): Promise<T> {
  if (isTauri) {
    return tauriInvoke<T>(command, args);
  }
  // Mock backend
  const handler = mockHandlers[command];
  if (!handler) {
    console.warn(`[mock] No handler for command: ${command}`);
    return undefined as any;
  }
  try {
    const result = handler(args ?? {});
    return result as T;
  } catch (e: any) {
    throw e.message ?? String(e);
  }
}

export interface Page {
  id: string;
  title: string;
  icon?: string;
  folder_id?: string;
  position: number;
  is_journal: boolean;
  journal_date?: string;
  created_at: string;
  updated_at: string;
}

export interface Block {
  id: string;
  page_id: string;
  parent_id?: string;
  position: number;
  content: string;
  format: string;
  collapsed: boolean;
  created_at: string;
  updated_at: string;
}

export interface PageTree {
  page: Page;
  blocks: Block[];
}

/** A block plus the title of its page: enough to show it and navigate to it. */
export interface BlockWithPage extends Block {
  page_title: string;
}

export interface Link {
  id: string;
  from_block: string;
  to_page?: string;
  to_block?: string;
  link_type: string;
  created_at: string;
  /** get_backlinks: the source block with its page title (no per-link getBlock). */
  block?: BlockWithPage;
}

export interface Property {
  id: string;
  entity_id: string;
  entity_type: string;
  key: string;
  value?: string;
  value_type: string;
  created_at: string;
  updated_at: string;
}

export interface GraphStats {
  pages: number;
  blocks: number;
  links: number;
  properties: number;
  events: number;
  orphan_pages: number;
  journal_pages: number;
}

// Page operations
export const listPages = (limit?: number) =>
  invoke<Page[]>("list_pages", { limit: limit ?? 100 });

export const getPageTree = (titleOrId: string) =>
  invoke<PageTree>("get_page_tree", { titleOrId });

export const createPage = (title: string) =>
  invoke<Page>("create_page", { title });

export const deletePage = (id: string) =>
  invoke<boolean>("delete_page", { id });

export const renamePage = (id: string, newTitle: string) =>
  invoke<Page>("rename_page", { id, newTitle });

// Block operations
export const createBlock = (pageId: string, content: string, parentId?: string) =>
  invoke<Block>("create_block", { pageId, content, parentId });

export const updateBlock = (id: string, content: string) =>
  invoke<Block>("update_block", { id, content });

export const deleteBlock = (id: string) =>
  invoke<boolean>("delete_block", { id });

/** A deleted block as snapshotted for undo: recreated with its ORIGINAL id. */
export interface RestoreBlock {
  id: string;
  page_id: string;
  parent_id?: string | null;
  content: string;
  position: number;
  /** [key, value] pairs re-applied to the restored block. */
  properties: Array<[string, string]>;
}

/**
 * Recreate previously deleted blocks with their original ids, parents,
 * positions, content and properties, in one transaction. `blocks` must be
 * ordered parents-first. Rejects if an id already exists, a parent is neither
 * existing nor in the batch, or a page is missing.
 */
export const restoreBlocks = (blocks: RestoreBlock[]) =>
  invoke<Block[]>("restore_blocks", { blocks });

/**
 * Snapshot `rootIds` and all their descendants (from `pageBlocks`, the page's
 * current blocks) parents-first, with properties, ready for `restoreBlocks`.
 * Roots nested inside another root's subtree are captured once.
 */
export async function snapshotSubtrees(rootIds: string[], pageBlocks: Block[]): Promise<RestoreBlock[]> {
  const children = new Map<string, Block[]>();
  for (const b of pageBlocks) {
    if (!b.parent_id) continue;
    const list = children.get(b.parent_id) ?? [];
    list.push(b);
    children.set(b.parent_id, list);
  }
  const kidsOf = (id: string) => (children.get(id) ?? []).slice().sort((x, y) => x.position - y.position);
  // Collect every block in the roots' subtrees (cycle-safe).
  const inSet = new Set<string>();
  const stack = pageBlocks.filter(b => rootIds.includes(b.id));
  while (stack.length > 0) {
    const b = stack.pop()!;
    if (inSet.has(b.id)) continue;
    inSet.add(b.id);
    stack.push(...kidsOf(b.id));
  }
  // BFS from the top-most blocks (parent outside the set), so every parent is
  // emitted before its children even when one root sits under another.
  const queue = pageBlocks
    .filter(b => inSet.has(b.id) && !(b.parent_id && inSet.has(b.parent_id)))
    .sort((x, y) => x.position - y.position);
  const result: Block[] = [];
  const emitted = new Set<string>();
  while (queue.length > 0) {
    const b = queue.shift()!;
    if (emitted.has(b.id)) continue;
    emitted.add(b.id);
    result.push(b);
    queue.push(...kidsOf(b.id));
  }
  return Promise.all(result.map(async b => {
    const props = await getProperties(b.id).catch(() => [] as Property[]);
    return {
      id: b.id,
      page_id: b.page_id,
      parent_id: b.parent_id ?? null,
      content: b.content,
      position: b.position,
      properties: props.map(p => [p.key, p.value ?? ""] as [string, string]),
    };
  }));
}

// Search
export const search = (query: string, limit?: number) =>
  invoke<Block[]>("search_blocks", { query, limit: limit ?? 20 });

// ── Cross-notebook search and links (core cross_notebook.rs) ──
export type SkipReason = "unavailable" | "locked" | "busy" | "error" | "timeout";
export interface SkippedNotebook {
  notebook_key: string;
  notebook_name: string;
  reason: SkipReason;
  /** "not available", "locked", … */
  label: string;
  detail: string;
}
export interface NotebookPageHit { id: string; title: string; is_journal: boolean }
export interface NotebookBlockHit { block: Block; page_title: string }
export interface NotebookResults {
  notebook_key: string;
  notebook_name: string;
  current: boolean;
  pages: NotebookPageHit[];
  blocks: NotebookBlockHit[];
}
export interface CrossSearch {
  query: string;
  results: NotebookResults[];
  skipped: SkippedNotebook[];
  elapsed_ms: number;
}
/** Every notebook except the open one, opened read-only (off the UI thread). */
export const searchOtherNotebooks = (query: string, perNotebook?: number) =>
  invoke<CrossSearch>("search_other_notebooks", { query, perNotebook: perNotebook ?? null });

export interface LinkRef { block_id?: string | null; notebook: string; page: string }
export type LinkStatus = "ok" | "local" | "page_missing" | "notebook_missing" | "unavailable";
export interface LinkTarget {
  status: LinkStatus;
  notebook_key: string | null;
  notebook_name: string | null;
  page_id: string | null;
  page_title: string | null;
  current: boolean;
  detail: string | null;
}
/** Resolve `[[Notebook::Page]]` links (by stored ids first, then by name). */
export const resolveNotebookLinks = (links: LinkRef[]) =>
  invoke<LinkTarget[]>("resolve_notebook_links", { links });
export interface NotebookPages { notebook_key: string; notebook_name: string; current: boolean; pages: NotebookPageHit[] }
/** Page titles of the notebook named `notebook` (link autocomplete), read-only. */
export const listNotebookPages = (notebook: string, query: string, limit?: number) =>
  invoke<NotebookPages>("list_notebook_pages", { notebook, query, limit: limit ?? null });

// Links
export const getBacklinks = (pageId: string) =>
  invoke<Link[]>("get_backlinks", { pageId });

// Stats
export const getGraphStats = () =>
  invoke<GraphStats>("get_graph_stats");

// Graph data
export interface GraphNode {
  id: string;
  title: string;
  block_count: number;
  link_count: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const getGraphData = () => invoke<GraphData>("get_graph_data");

// Unlinked references
export const getUnlinkedReferences = (pageId: string) =>
  invoke<Block[]>("get_unlinked_references", { pageId });

// Query engine
export interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
}

export const runQuery = (sql: string) =>
  invoke<QueryResult>("run_query", { sql });

// Journal
export const getJournal = (date?: string) =>
  invoke<PageTree>("get_journal", { date });

// Folders
export interface Folder {
  id: string;
  name: string;
  parent_id?: string;
  icon?: string;
  color?: string;
  position: number;
  collapsed: boolean;
}

export interface FolderTree {
  id: string;
  name: string;
  parent_id?: string;
  icon?: string;
  color?: string;
  position: number;
  collapsed: boolean;
  children: FolderTree[];
  pages: Page[];
}

export interface FolderTreeRoot {
  folders: FolderTree[];
  root_pages: Page[];
}

export const getFolderTree = () =>
  invoke<FolderTreeRoot>("get_folder_tree");

export const createFolder = (name: string, parentId?: string) =>
  invoke<Folder>("create_folder", { name, parentId });

export const movePageToFolder = (pageId: string, folderId?: string) =>
  invoke<Page>("move_page_to_folder", { pageId, folderId });

export const reorderPage = (id: string, newPosition: number) =>
  invoke<Page>("reorder_page", { id, newPosition });

export const deleteFolder = (id: string) =>
  invoke<boolean>("delete_folder", { id });

export const renameFolder = (id: string, newName: string) =>
  invoke<Folder>("rename_folder", { id, newName });

export const updateFolderAppearance = (id: string, icon?: string, color?: string) =>
  invoke<Folder>("update_folder_appearance", { id, icon: icon ?? null, color: color ?? null });

// Properties
export const setProperty = (
  entityId: string,
  entityType: string,
  key: string,
  value: string,
  valueType?: string,
) => invoke<Property>("set_property", { entityId, entityType, key, value, valueType });

export const getProperties = (entityId: string) =>
  invoke<Property[]>("get_properties", { entityId });

/** Properties of many entities in ONE call: id -> properties (ids without any are absent). */
export const getPropertiesBatch = (entityIds: string[]) =>
  invoke<Record<string, Property[]>>("get_properties_batch", { entityIds });

export const deleteProperty = (entityId: string, key: string) =>
  invoke<boolean>("delete_property", { entityId, key });

export const getInheritedProperties = (blockId: string) =>
  invoke<Property[]>("get_inherited_properties", { blockId });

// SRS Cards
export interface Card {
  id: string;
  block_id: string;
  card_type: string;
  due: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: string;
  last_review?: string;
  created_at: string;
  updated_at: string;
}

export interface SrsStats {
  due_count: number;
  reviewed_today: number;
  total_cards: number;
}

export const createCard = (blockId: string, cardType: string) =>
  invoke<Card>("create_card", { blockId, cardType });

/** Every card (oldest first): which blocks are flashcards. */
export const listCards = () =>
  invoke<Card[]>("list_cards");

export const getDueCards = (limit?: number) =>
  invoke<Card[]>("get_due_cards", { limit: limit ?? 50 });

export const reviewCard = (cardId: string, rating: string) =>
  invoke<Card>("review_card", { cardId, rating });

export const getSrsStats = () =>
  invoke<SrsStats>("get_srs_stats");

export const deleteCard = (cardId: string) =>
  invoke<boolean>("delete_card", { cardId });

// Favorites
export const addFavorite = (pageId: string) =>
  invoke<void>("add_favorite", { pageId });

export const removeFavorite = (pageId: string) =>
  invoke<boolean>("remove_favorite", { pageId });

export const listFavorites = () =>
  invoke<Page[]>("list_favorites");

export const reorderFavorite = (pageId: string, newPosition: number) =>
  invoke<void>("reorder_favorite", { pageId, newPosition });

// Block move
export const moveBlock = (id: string, newParent: string, position: number) =>
  invoke<Block>("move_block", { id, newParent, position });

export const reparentBlock = (id: string, parentId?: string) =>
  invoke<Block>("reparent_block", { id, parentId });

export const reorderBlock = (id: string, parentId: string | undefined, position: number) =>
  invoke<Block>("reorder_block", { id, parentId, position });

// Aliases
export const addAlias = (pageId: string, alias: string) =>
  invoke<void>("add_alias", { pageId, alias });

export const removeAlias = (alias: string) =>
  invoke<boolean>("remove_alias", { alias });

export const getAliases = (pageId: string) =>
  invoke<string[]>("get_aliases", { pageId });

// Templates
export interface Template {
  id: string;
  name: string;
  description?: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export const createTemplate = (name: string, content: string, description?: string) =>
  invoke<Template>("create_template", { name, description, content });

export const listTemplates = () =>
  invoke<Template[]>("list_templates");

export const applyTemplate = (pageId: string, templateName: string) =>
  invoke<Block[]>("apply_template", { pageId, templateName });

export const deleteTemplate = (name: string) =>
  invoke<boolean>("delete_template", { name });

// Export / Publish
export const exportOpml = () =>
  invoke<string>("export_opml");

export const exportJson = () =>
  invoke<any>("export_json");

export const publishSite = (outputDir: string) =>
  invoke<string[]>("publish_site", { outputDir });

// Plugins
export interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  enabled: boolean;
  permissions?: string;
  config?: string;
  entry_point?: string;
  created_at: string;
  updated_at: string;
}

export const listPlugins = () =>
  invoke<Plugin[]>("list_plugins");

export const registerPlugin = (name: string, version: string, description?: string, author?: string) =>
  invoke<Plugin>("register_plugin", { name, version, description, author });

export const enablePlugin = (name: string) =>
  invoke<Plugin>("enable_plugin", { name });

export const disablePlugin = (name: string) =>
  invoke<Plugin>("disable_plugin", { name });

export const uninstallPlugin = (name: string) =>
  invoke<boolean>("uninstall_plugin", { name });

// ── Notebooks ──

/** Open another notebook (by key). UI code should call lib/notebooks.switchNotebook,
 *  which also resets per-notebook UI state. */
export const switchNotebook = (key: string) =>
  invoke<boolean>("switch_notebook", { key });

/** The open notebook's key. */
export const getCurrentNotebook = () =>
  invoke<string>("get_current_notebook");

export interface NotebookInfo {
  /** What switchNotebook() takes: a legacy notebook's name, or a folder notebook's id. */
  key: string;
  name: string;
  /** "legacy" (~/.minotes/<name>.db) or "folder" (a notebook folder). */
  kind: "legacy" | "folder";
  /** The notebook folder, or the legacy database file. */
  path: string;
  db_path: string;
  /** The always-current markdown copy. */
  mirror_dir: string;
  /** False when the folder is missing (unplugged drive, moved): offer "Locate…". */
  available: boolean;
  last_opened: string | null;
  size_bytes: number;
  modified_at: string;
  /** File-sync service the folder seems to be in (Dropbox, iCloud Drive, …). */
  cloud: string | null;
}

export interface NotebookSession {
  key: string;
  name: string;
  kind: "legacy" | "folder";
  path: string;
  db_path: string;
  mirror_dir: string;
  /** Another MiNotes window has this notebook open: nothing can be changed here. */
  read_only: boolean;
  held_by: string | null;
  /** One-off notice (e.g. the last notebook's folder is missing). */
  notice: string | null;
  cloud: string | null;
  conflicted_copies: string[];
}

export interface MirrorStatus {
  dir: string;
  enabled: boolean;
  last_written_at: string | null;
  last_pass_at: string | null;
  last_full_at: string | null;
  error: string | null;
  pages: number;
  /** Changes are waiting for the 2 s quiet period. */
  pending: boolean;
  /** The last pass failed: "Markdown copy is behind — retry". */
  behind: boolean;
  read_only: boolean;
}

export const listNotebooks = () => invoke<NotebookInfo[]>("list_notebooks");
export const getNotebookSession = () => invoke<NotebookSession>("get_notebook_session");
export const dismissNotebookNotice = () => invoke<void>("dismiss_notebook_notice");
export const defaultNotebookLocation = (name: string) =>
  invoke<string>("default_notebook_location", { name });
/** Create a notebook folder (default ~/MiNotes/<name>). Does not switch to it. */
export const createNotebook = (name: string, location?: string) =>
  invoke<NotebookInfo>("create_notebook", { name, location: location ?? null });
/** Register an existing notebook folder. Does not switch to it. */
export const openNotebookFolder = (path: string) =>
  invoke<NotebookInfo>("open_notebook_folder", { path });
export const locateNotebook = (key: string, path: string) =>
  invoke<NotebookInfo>("locate_notebook", { key, path });
export const renameNotebook = (key: string, name: string) =>
  invoke<NotebookInfo>("rename_notebook", { key, name });
export const deleteNotebook = (key: string) => invoke<void>("delete_notebook", { key });
export const forgetNotebook = (key: string) => invoke<void>("forget_notebook", { key });
export const takeOverNotebook = () => invoke<NotebookSession>("take_over_notebook");
/** Convert the open ~/.minotes notebook into a folder notebook at `path`. */
export const moveNotebookToFolder = (path: string) =>
  invoke<NotebookSession>("move_notebook_to_folder", { path });
export const mirrorStatus = () => invoke<MirrorStatus>("mirror_status");
export const mirrorRebuild = () => invoke<MirrorStatus>("mirror_rebuild");
export const mirrorOpenFolder = () => invoke<void>("mirror_open_folder");

/** Native folder picker (Tauri dialog plugin). Null when cancelled. */
export const pickFolderNative = (title: string, defaultPath?: string) =>
  invoke<string | null>("plugin:dialog|open", {
    options: { directory: true, multiple: false, title, defaultPath: defaultPath || undefined },
  });

// Web Clipper API (F-021)
export const clipContent = (
  title: string,
  content: string,
  url?: string,
  tags?: string[],
) => invoke<Page>("clip_content", { title, content, url, tags });

// PDF Highlights (F-013)
export interface Highlight {
  id: string;
  pdf_path: string;
  page_num: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text?: string;
  note?: string;
  block_id?: string;
  created_at: string;
  updated_at: string;
}

export const createHighlight = (
  pdfPath: string,
  pageNum: number,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  text?: string,
  note?: string,
) => invoke<Highlight>("create_highlight", { pdfPath, pageNum, x, y, width, height, color, text, note });

export const getHighlights = (pdfPath: string) =>
  invoke<Highlight[]>("get_highlights", { pdfPath });

export const updateHighlightNote = (id: string, note: string) =>
  invoke<Highlight>("update_highlight_note", { id, note });

export const deleteHighlight = (id: string) =>
  invoke<boolean>("delete_highlight", { id });

export const searchHighlights = (query: string) =>
  invoke<Highlight[]>("search_highlights", { query });

// CRDT Sync (F-015)
export interface SyncStatus {
  total_pages: number;
  synced_pages: number;
  pending_changes: number;
  last_sync: string | null;
}

export interface VersionInfo {
  hash: string;
  timestamp: string;
  actor: string;
  message: string | null;
}

export const getSyncStatus = () =>
  invoke<SyncStatus>("get_sync_status");

export const syncPage = (pageId: string) =>
  invoke<number[]>("sync_page", { pageId });

export const getVersionHistory = (pageId: string, limit?: number) =>
  invoke<VersionInfo[]>("get_version_history", { pageId, limit });

export const restoreVersion = (pageId: string, versionHash: string) =>
  invoke<void>("restore_version", { pageId, versionHash });

// CSS Snippets
export interface CssSnippet {
  id: string;
  name: string;
  css: string;
  enabled: boolean;
  source: string;
  created_at: string;
}

export const addCssSnippet = (name: string, css: string, source?: string) =>
  invoke<CssSnippet>("add_css_snippet", { name, css, source: source ?? "custom" });

export const listCssSnippets = () =>
  invoke<CssSnippet[]>("list_css_snippets");

export const toggleCssSnippet = (name: string) =>
  invoke<CssSnippet>("toggle_css_snippet", { name });

export const deleteCssSnippet = (name: string) =>
  invoke<boolean>("delete_css_snippet", { name });

export const getEnabledCssSnippets = () =>
  invoke<CssSnippet[]>("get_enabled_css_snippets");

export const updateCssSnippet = (name: string, css: string) =>
  invoke<CssSnippet>("update_css_snippet", { name, css });

// Undo
export const undo = () =>
  invoke<number | null>("undo");

// File export — saves PNG to Downloads (WSL-aware in Tauri mode)
export const savePngToDownloads = (filename: string, data: number[]) =>
  invoke<string>("save_png_to_downloads", { filename, data });

/** Desktop only: asks where to save via the OS save dialog. Null if cancelled. */
export const saveExportFile = (filename: string, data: number[]) =>
  invoke<string | null>("save_export_file", { filename, data });

// Feature 8: Link Preview — fetch OpenGraph metadata
export interface OgMetadata {
  title: string;
  description: string;
  image: string;
}

export const fetchOgMetadata = (url: string) =>
  invoke<OgMetadata>("fetch_og_metadata", { url });

// Feature 9: Block Transclusion — get single block by ID
export const getBlock = (id: string) =>
  invoke<BlockWithPage | null>("get_block", { id });

/** Several blocks (with page titles) in ONE call, in input order; unknown ids skipped. */
export const getBlocks = (ids: string[]) =>
  invoke<BlockWithPage[]>("get_blocks", { ids });

// Archive
export const archivePage = (id: string) =>
  invoke<void>("archive_page", { id });

export const unarchivePage = (id: string) =>
  invoke<void>("unarchive_page", { id });

export const archiveFolder = (id: string) =>
  invoke<number>("archive_folder", { id });

export const unarchiveFolder = (id: string) =>
  invoke<void>("unarchive_folder", { id });

export interface ArchiveItem {
  id: string;
  title: string;
  item_type: "page" | "folder";
  page_count: number;
  archived_at: string;
}

export const listArchived = () =>
  invoke<ArchiveItem[]>("list_archived");

export const archivedCount = () =>
  invoke<number>("archived_count");

// Trash
export interface TrashItem {
  id: string;
  title: string;
  item_type: "page" | "folder";
  page_count: number;
  deleted_at: string;
}

export const trashPage = (id: string) =>
  invoke<void>("trash_page", { id });

export const trashFolder = (id: string) =>
  invoke<number>("trash_folder", { id });

export const restoreFromTrash = (id: string, itemType: string) =>
  invoke<void>("restore_from_trash", { id, itemType });

export const permanentlyDelete = (id: string, itemType: string) =>
  invoke<void>("permanently_delete", { id, itemType });

export const listTrash = () =>
  invoke<TrashItem[]>("list_trash");

export const emptyTrash = () =>
  invoke<number>("empty_trash");

// Git Sync
export interface GitSyncStatus {
  enabled: boolean;
  remote_url: string | null;
  branch: string | null;
  last_sync: string | null;
}

export interface GitSyncResult {
  /** Git AND the import went through. */
  success: boolean;
  pages_exported: number;
  pages_imported: number;
  conflicts_resolved: number;
  error: string | null;
  /** Per-file problems importing the other device's changes. */
  import_errors?: string[];
  /** Deletions from another device the mass-delete guard held for the user. */
  held_deletions?: HeldDeletions | null;
  /** The remote could not be reached. */
  offline?: boolean;
}

export interface HeldDeletions {
  pages: number;
  folders: number;
  titles: string[];
  total_pages: number;
}

/** "trash": apply the other device's deletions (to trash). "keep": keep the pages. */
export const gitSyncResolveDeletions = (action: "trash" | "keep") =>
  invoke<number>("git_sync_resolve_deletions", { action });

// ── Outside edits of the markdown copy (PRD-notebooks Phase 4) ──

export interface OutsidePageRef { page_id: string; title: string; path: string }
export interface OutsideImportedPage extends OutsidePageRef {
  blocks_created: number;
  blocks_updated: number;
  blocks_removed: number;
  /** Trash page holding the blocks whose lines were removed in the file. */
  removed_page_id: string | null;
  before: RestoreBlock[];
  after: RestoreBlock[];
}
export interface OutsideConflictCopy {
  page_id: string | null;
  title: string;
  copy_id: string;
  copy_title: string;
  path: string;
}
/** Event "outside-edits": what the app imported from edits made in another program. */
export interface OutsideReport {
  imported: OutsideImportedPage[];
  created: OutsidePageRef[];
  conflicts: OutsideConflictCopy[];
  trashed: OutsidePageRef[];
  /** Deleted files whose pages the mass-delete guard kept (files written again). */
  kept: OutsidePageRef[];
  /** Deleted files whose pages were edited here since (files written again). */
  restored: OutsidePageRef[];
  rejected: { path: string; reason: string }[];
  errors: string[];
}

/** Undo/redo one outside-edit import: set the page's blocks to a snapshot. */
export const outsideEditSetBlocks = (pageId: string, blocks: RestoreBlock[], parkTitle?: string, cleanupPageId?: string | null) =>
  invoke<string | null>("outside_edit_set_blocks", { pageId, blocks, parkTitle: parkTitle ?? null, cleanupPageId: cleanupPageId ?? null });

export const gitAvailable = () =>
  invoke<boolean>("git_available");

export const gitSyncEnable = () =>
  invoke<GitSyncStatus>("git_sync_enable");

export const gitSyncDisable = () =>
  invoke<void>("git_sync_disable");

export const gitSync = () =>
  invoke<GitSyncResult>("git_sync");

export const gitSyncStatus = () =>
  invoke<GitSyncStatus>("git_sync_status");

// AI: TODO count
export const getPendingTodoCount = () =>
  invoke<number>("get_pending_todo_count");

// AI: List all pending TODOs with source page titles
export const listPendingTodos = () =>
  invoke<Array<{ page_title: string; text: string }>>("list_pending_todos");

export const listPendingTodosWithIds = () =>
  invoke<Array<{ page_id: string; page_title: string; text: string }>>("list_pending_todos_with_page_ids");

export { isTauri };

// ── Whiteboards (DB-backed; keyed by the id in `{{whiteboard:<id>}}`) ──
/** Returns the stored whiteboard JSON, or null if never saved. */
export const getWhiteboard = (id: string) =>
  invoke<string | null>("get_whiteboard", { id }).then((d) => d ?? null);

export const saveWhiteboard = (id: string, data: string) =>
  invoke<void>("save_whiteboard", { id, data });
// ── End whiteboards ──

// ── PDF viewer ──
/**
 * Bytes of a local PDF. In the desktop app the webview can't read files by path,
 * so they come over IPC; in browser mode this returns null and the caller loads
 * `path` as a URL instead.
 */
export async function readPdfFile(path: string): Promise<Uint8Array | null> {
  if (!isTauri) return null;
  const buf = await tauriInvoke<ArrayBuffer>("read_pdf_file", { path });
  return new Uint8Array(buf);
}

// ── AI platform ──
// Commands in src-tauri/src/ai_commands.rs (logic: minotes-core `ai`); browser
// mode is served by lib/aiMock.ts. The API key never comes back from the
// backend — only its status.
export type AiProviderKind = "off" | "openrouter" | "local";

export interface AiSettings {
  provider: AiProviderKind;
  models: { interactive: string | null; bulk: string | null; agent: string | null };
  scope: { kind: "notebook" | "folders" | "page"; folder_ids: string[] };
  monthly_cap_usd: number;
  keep_transcripts: boolean;
  local: { base_url: string; model: string; supports_tools: boolean };
  reasoning_effort: "low" | "medium" | "high" | null;
  max_tool_iterations: number;
  run_token_budget: number;
  max_output_tokens: number;
}

export interface AiKeyStatus { configured: boolean; source: "keychain" | "env" | "none"; keychain_available: boolean }

export interface AiStatus {
  settings: AiSettings;
  key: AiKeyStatus;
  configured: boolean;
  problem: string | null;
  spend_this_month_usd: number;
  data_notice: string;
  effective_model: string | null;
  recommended_model: string | null;
  scope_label: string;
  catalog_fetched_at: string | null;
}

/** Prices are USD per token. */
export interface AiModelInfo {
  id: string; name: string; created: number; context_length: number | null;
  prompt_price: number; completion_price: number; cache_read_price: number | null;
}

export interface AiModelList { models: AiModelInfo[]; recommended: string | null; fetched_at: string | null; error: string | null }

export interface AiCitation { block_id: string; page_id: string; page_title: string; snippet: string }

export interface AiUsage { prompt_tokens: number; completion_tokens: number; cached_tokens: number; cost: number | null }

export interface AiRunOutput {
  run_id: string;
  /** Contains only validated `[[cite:<block-id>]]` markers. */
  answer: string;
  citations: AiCitation[];
  stripped_citations: number;
  outcome: string;
  notice: string | null;
  model: string;
  usage: AiUsage;
  cost_usd: number;
  iterations: number;
  tool_calls: number;
  spend_this_month_usd: number;
  cap_usd: number;
}

export interface AiRunRecord {
  id: string; task: string; scope: string; provider: string; model: string;
  input_tokens: number; output_tokens: number; cached_tokens: number; tool_calls: number;
  cost_usd: number; started_at: string; finished_at: string | null; outcome: string;
  error: string | null; has_transcript: boolean;
}

export type AiProgress =
  | { type: "started"; run_id: string; model: string }
  | { type: "turn"; n: number }
  | { type: "delta"; text: string }
  | { type: "status"; text: string };

export type AiStreamEvent =
  | { conversation_id: string; kind: "progress"; event: AiProgress }
  | { conversation_id: string; kind: "done"; result: AiRunOutput }
  | { conversation_id: string; kind: "error"; message: string; not_configured: boolean };

export const aiGetStatus = () => invoke<AiStatus>("ai_get_status");
export const aiSaveSettings = (settings: AiSettings) => invoke<AiStatus>("ai_save_settings", { settings });
export const aiSetApiKey = (key: string) => invoke<AiKeyStatus>("ai_set_api_key", { key });
export const aiClearApiKey = () => invoke<AiKeyStatus>("ai_clear_api_key");
export const aiListModels = (refresh = false) => invoke<AiModelList>("ai_list_models", { refresh });
/** Starts a run; returns the conversation id. Results arrive via onAiEvent. */
export const aiAsk = (question: string, conversationId: string | null, currentPageId: string | null) =>
  invoke<string>("ai_ask", { question, conversationId, currentPageId });
export const aiCancel = (conversationId: string) => invoke<void>("ai_cancel", { conversationId });
export const aiResetConversation = (conversationId: string) => invoke<void>("ai_reset_conversation", { conversationId });
export const aiListRuns = (limit = 20) => invoke<AiRunRecord[]>("ai_list_runs", { limit });

/** Subscribe to AI stream events. Returns an unsubscribe function. */
export async function onAiEvent(cb: (e: AiStreamEvent) => void): Promise<() => void> {
  if (isTauri) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AiStreamEvent>("ai://event", (e) => cb(e.payload));
  }
  const { aiMockEvents } = await import("./aiMock");
  const h = (e: Event) => cb((e as CustomEvent<AiStreamEvent>).detail);
  aiMockEvents.addEventListener("event", h);
  return () => aiMockEvents.removeEventListener("event", h);
}
// ── End AI platform ──

// ── Import / attachments ──
// Commands in src-tauri/src/import_commands.rs (logic: minotes-core `import`,
// `repo::attachments`); browser mode is served by lib/importMock.ts.
import type { Attachment } from "./attachments";

/** Store bytes as an attachment (raw IPC body in the app — no base64). */
export async function storeAttachment(name: string, mime: string, bytes: Uint8Array): Promise<Attachment> {
  if (isTauri) {
    return tauriInvoke<Attachment>("store_attachment", bytes, {
      headers: { "x-name": encodeURIComponent(name), "x-mime": encodeURIComponent(mime) },
    });
  }
  return invoke<Attachment>("store_attachment", { name, mime, bytes });
}
/** Store the files the OS just dropped on the window (desktop only). */
export const storeDroppedFiles = () => invoke<Attachment[]>("store_dropped_files");
export const openAttachment = (hash: string) => invoke<void>("open_attachment", { hash });
export const getAttachment = (hash: string) => invoke<Attachment | null>("get_attachment", { hash });

export type ImportSourceKind = "obsidian" | "markdown" | "evernote";
export type SplitMode = "outline" | "paragraph" | "note";
export interface ImportOptions {
  split: SplitMode;
  daily_notes: boolean;
  unlinked_files: boolean;
  collisions: "keep_both" | "skip";
  parent_project: string | null;
  batch_size?: number;
}
export interface ImportWarning {
  category: string;
  label: string;
  count: number;
  notes: string[];
  examples: string[];
}
export interface ImportTreeNode { name: string; kind: "project" | "page" | "journal"; children: ImportTreeNode[]; more: number }
export interface ImportSample { title: string; source_path: string; source: string; blocks: { depth: number; content: string }[] }
export interface ImportPreview {
  source: ImportSourceKind;
  source_label: string;
  source_name: string;
  counts: {
    notes: number; pages: number; journals: number; folders: number; attachments: number;
    attachment_bytes: number; total_bytes: number; skipped: number; reimport: number;
  };
  tree: ImportTreeNode[];
  samples: ImportSample[];
  warnings: ImportWarning[];
  title_mappings: [string, string][];
}
export type ImportDestination =
  | { kind: "new_notebook"; name?: string | null; location?: string | null }
  | { kind: "current"; project?: string | null };
export interface ImportReportWarning { category: string; label: string; count: number; pages: [string, string | null][]; examples: string[] }
export interface ImportResult {
  run_id: string;
  source: string;
  source_name: string;
  status: string;
  pages_created: number;
  journals_created: number;
  folders_created: number;
  blocks_created: number;
  attachments_created: number;
  attachments_reused: number;
  attachment_bytes: number;
  pages_updated: number;
  pages_unchanged: number;
  reimported_copies: number;
  skipped: number;
  warnings: ImportReportWarning[];
  report_page_id: string | null;
  report_page_title: string | null;
  duration_ms: number;
  notebook_key: string | null;
  notebook_name: string | null;
}
export interface ImportUndoReport {
  run_id: string;
  undone: boolean;
  pages_deleted: number;
  folders_deleted: number;
  attachments_deleted: number;
  edited: { id: string; title: string }[];
  updated_kept: number;
}
export interface ImportRun { id: string; source: string; origin: string; source_path: string; started_at: string; finished_at: string | null; status: string; report_page: string | null; pages: number }
export interface ImportProgress { phase: string; done: number; total: number; current: string }

export const importDetect = (path: string) => invoke<{ kind: ImportSourceKind; name: string }>("import_detect", { path });
export const importScan = (kind: ImportSourceKind, paths: string[], options: ImportOptions) =>
  invoke<ImportPreview>("import_scan", { kind, paths, options });
export const importPreview = (options: ImportOptions, destination: ImportDestination) =>
  invoke<ImportPreview>("import_preview", { options, destination });
export const importRun = (destination: ImportDestination, options: ImportOptions) =>
  invoke<ImportResult>("import_run", { destination, options });
export const importCancel = () => invoke<void>("import_cancel");
export const importDiscard = () => invoke<void>("import_discard");
export const importUndo = (runId: string, keepEdited = false) => invoke<ImportUndoReport>("import_undo", { runId, keepEdited });
export const importRuns = () => invoke<ImportRun[]>("import_runs");

/** Native file picker for .enex exports. Null when cancelled. */
export const pickEnexFilesNative = (title: string) =>
  invoke<string[] | string | null>("plugin:dialog|open", {
    options: { directory: false, multiple: true, title, filters: [{ name: "Evernote export", extensions: ["enex"] }] },
  });

/** Subscribe to import progress. Returns an unsubscribe function. */
export async function onImportProgress(cb: (p: ImportProgress) => void): Promise<() => void> {
  if (isTauri) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<ImportProgress>("import-progress", (e) => cb(e.payload));
  }
  const h = (e: Event) => cb((e as CustomEvent<ImportProgress>).detail);
  window.addEventListener("minotes-import-progress", h);
  return () => window.removeEventListener("minotes-import-progress", h);
}
// ── End import ──
