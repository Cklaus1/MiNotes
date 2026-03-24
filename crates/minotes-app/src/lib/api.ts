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

export interface Link {
  id: string;
  from_block: string;
  to_page?: string;
  to_block?: string;
  link_type: string;
  created_at: string;
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

// Search
export const search = (query: string, limit?: number) =>
  invoke<Block[]>("search_blocks", { query, limit: limit ?? 20 });

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

// Block move
export const moveBlock = (id: string, newParent: string, position: number) =>
  invoke<Block>("move_block", { id, newParent, position });

export const reparentBlock = (id: string, parentId?: string) =>
  invoke<Block>("reparent_block", { id, parentId });

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

// Multi-Graph Management (F-020)
export interface GraphInfo {
  name: string;
  path: string;
  size_bytes: number;
  modified_at: string;
}

export const listGraphs = () =>
  invoke<GraphInfo[]>("list_graphs");

export const switchGraph = (name: string) =>
  invoke<boolean>("switch_graph", { name });

export const createGraph = (name: string) =>
  invoke<GraphInfo>("create_graph_cmd", { name });

export const deleteGraph = (name: string) =>
  invoke<boolean>("delete_graph_cmd", { name });

export const getCurrentGraph = () =>
  invoke<string>("get_current_graph");

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

// Undo
export const undo = () =>
  invoke<number | null>("undo");

// File export — saves PNG to Downloads (WSL-aware in Tauri mode)
export const savePngToDownloads = (filename: string, data: number[]) =>
  invoke<string>("save_png_to_downloads", { filename, data });

export { isTauri };
