import { invoke } from "@tauri-apps/api/core";

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
