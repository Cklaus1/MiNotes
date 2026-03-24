/**
 * Test API — exposes app internals on window.__MINOTES__ for automation tools.
 *
 * Only active in development mode. Gives agent-browser (and other tools)
 * a reliable way to interact with ProseMirror editors, navigate pages,
 * and verify app state without fighting the DOM event model.
 *
 * Usage from agent-browser:
 *   agent-browser eval "window.__MINOTES__.typeInBlock(0, 'Hello world')"
 *   agent-browser eval "window.__MINOTES__.getBlocks()"
 *   agent-browser eval "window.__MINOTES__.navigateTo('Project Alpha')"
 */

export interface MiNotesTestApi {
  // ── Block editing ──
  /** Type text into a block by index (0-based). Uses ProseMirror's insertText. */
  typeInBlock: (blockIndex: number, text: string) => boolean;
  /** Replace all content in a block by index. */
  setBlockContent: (blockIndex: number, markdown: string) => boolean;
  /** Get the text content of a block by index. */
  getBlockContent: (blockIndex: number) => string | null;
  /** Get all blocks as {index, content} array. */
  getBlocks: () => Array<{ index: number; content: string }>;
  /** Press Enter in a block (trigger block split). */
  pressEnterInBlock: (blockIndex: number) => boolean;
  /** Focus a block by index. */
  focusBlock: (blockIndex: number) => boolean;

  // ── Navigation ──
  /** Navigate to a page by title or ID. */
  navigateTo: (titleOrId: string) => boolean;
  /** Open today's journal. */
  openJournal: (date?: string) => boolean;
  /** Open search panel. */
  openSearch: () => boolean;
  /** Open settings. */
  openSettings: () => boolean;
  /** Close any open panel. */
  closePanel: () => boolean;

  // ── State queries ──
  /** Get current page title. */
  getCurrentPage: () => string | null;
  /** Get number of blocks on current page. */
  getBlockCount: () => number;
  /** Check if a panel is open. */
  isPanelOpen: (name: string) => boolean;

  // ── Version ──
  version: string;
}

// The actual implementation is set by App.tsx / PageView.tsx at runtime
let api: Partial<MiNotesTestApi> = { version: "1.0.0" };

export function getTestApi(): Partial<MiNotesTestApi> {
  return api;
}

export function registerTestApi(partial: Partial<MiNotesTestApi>) {
  api = { ...api, ...partial };
  (window as any).__MINOTES__ = api;
}

export function initTestApi() {
  // Expose on window immediately with stubs
  (window as any).__MINOTES__ = api;
}
