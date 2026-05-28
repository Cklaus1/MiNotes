/**
 * MiNotes application settings.
 * Stored in localStorage. Provides a config area for power-user features.
 */

export interface AiSettings {
  /** Auto-suggest tags when saving a page (default: on) */
  autoTag: boolean;
  /** Suggest related pages for wikilinking (default: on) */
  linkSuggestions: boolean;
  /** Extract TODOs from note content (default: on) */
  todoExtraction: boolean;
}

export interface MiNotesSettings {
  /** Enable Obsidian-compatible CM6 editor mode (default: off) */
  obsidianEditorEnabled: boolean;
  /** Default editor mode for new blocks when obsidianEditor is enabled */
  defaultEditorMode: "minotes" | "obsidian";
  /** Enable full tree mode with connector lines (default: off) */
  fullTreeMode: boolean;
  /** AI assistant settings */
  ai: AiSettings;
}

const STORAGE_KEY = "minotes-settings";

const DEFAULTS: MiNotesSettings = {
  obsidianEditorEnabled: false,
  defaultEditorMode: "minotes",
  fullTreeMode: false,
  ai: {
    autoTag: true,
    linkSuggestions: true,
    todoExtraction: true,
  },
};

export function getSettings(): MiNotesSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function updateSettings(partial: Partial<MiNotesSettings>): MiNotesSettings {
  const current = getSettings();
  const updated = { ...current, ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  window.dispatchEvent(new CustomEvent("minotes-settings-changed", { detail: updated }));
  return updated;
}

export function useSettings(): MiNotesSettings {
  // This is a simple getter — for reactive updates, components
  // should listen to the 'minotes-settings-changed' event
  return getSettings();
}
