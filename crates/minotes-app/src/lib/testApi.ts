/**
 * Test API — exposes app internals on window.__MINOTES__ for automation tools.
 *
 * Uses a SINGLE mutable object. registerTestApi() sets properties on it
 * without creating a new object, so multiple callers (App.tsx, PageView.tsx)
 * can register methods without overwriting each other.
 */

export interface MiNotesTestApi {
  typeInBlock: (blockIndex: number, text: string) => boolean;
  setBlockContent: (blockIndex: number, markdown: string) => boolean;
  getBlockContent: (blockIndex: number) => string | null;
  getBlocks: () => Array<{ index: number; content: string }>;
  pressEnterInBlock: (blockIndex: number) => boolean;
  focusBlock: (blockIndex: number) => boolean;
  navigateTo: (titleOrId: string) => boolean;
  openJournal: (date?: string) => boolean;
  openSearch: () => boolean;
  openSettings: () => boolean;
  closePanel: () => boolean;
  refreshSidebar: () => boolean;
  createPage: (title: string) => Promise<boolean>;
  createBlockInCurrentPage: (content: string) => Promise<boolean>;
  getCurrentPage: () => string | null;
  /** Id of the whiteboard open in Draw mode (null when Draw isn't open). */
  getOpenWhiteboardId: () => string | null;
  getBlockCount: () => number;
  isPanelOpen: (name: string) => boolean;
  toggleCheckbox: (blockIndex: number, itemIndex?: number) => boolean;
  /** Put the cursor at a text offset in block N and split there (Enter-key path). */
  splitBlockAt: (blockIndex: number, offset: number) => boolean;
  /** Merge block N into the previous block (Backspace-at-start path). */
  mergeWithPrevious: (blockIndex: number) => boolean;
  /** Cycle TODO state of block N (Ctrl+Enter path). */
  toggleTodoInBlock: (blockIndex: number) => boolean;
  /** Markdown currently in block N's editor (may be ahead of getBlockContent). */
  getLiveBlockContent: (blockIndex: number) => string | null;
  /** Collapse/expand block N (bullet collapse toggle path). */
  toggleCollapseBlock: (blockIndex: number) => boolean;
  /** Multi-select visible blocks fromIndex..toIndex (shift-click selection). */
  selectBlocks: (fromIndex: number, toIndex: number) => number;
  getSelectedCount: () => number;
  /** Table structure command at the cursor in block N (toolbar path); saves. */
  tableAction: (blockIndex: number, action: string) => boolean;
  /** Make (true) / remove (false) block N's flashcard (context-menu path). */
  setFlashcard: (blockIndex: number, on: boolean) => Promise<boolean>;
  /** Keydown into block N's editor (same handlers as the real key). */
  pressKeyInBlock: (blockIndex: number, key: string, mods?: { shift?: boolean; ctrl?: boolean; alt?: boolean; focus?: boolean }) => boolean;
  /** Visible blocks with depth and parent index. */
  getBlockTree: () => Array<{ index: number; content: string; depth: number; parentIndex: number; id: string; position: number }>;
  /** Index of the visible block whose editor has focus, -1 if none. */
  getFocusedBlockIndex: () => number;
  /** Indices of selected (highlighted, not editing) blocks. */
  getSelectedIndices: () => number[];
  /** Follow a ((block ref)) to its block (block-ref click path). */
  openBlockRef: (blockId: string) => boolean;
  version: string;
}

// Single mutable object — never replaced, only mutated
const api: any = { version: "1.0.0" };

export function registerTestApi(partial: Partial<MiNotesTestApi>) {
  // MUTATE the existing object, don't replace it
  for (const [key, value] of Object.entries(partial)) {
    api[key] = value;
  }
  // Ensure window ref always points to the same object
  (window as any).__MINOTES__ = api;
}

export function initTestApi() {
  (window as any).__MINOTES__ = api;
}
