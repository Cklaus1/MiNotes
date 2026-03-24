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
  getCurrentPage: () => string | null;
  getBlockCount: () => number;
  isPanelOpen: (name: string) => boolean;
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
