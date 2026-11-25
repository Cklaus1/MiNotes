/**
 * getSettings() reads and parses localStorage on every call. Components rendered
 * once per block (thousands on a big page) use this cached copy instead; it is
 * dropped whenever settings change.
 */
import { getSettings, type MiNotesSettings } from "./settings";

let cached: MiNotesSettings | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("minotes-settings-changed", () => { cached = null; });
  window.addEventListener("storage", () => { cached = null; });
}

export function getSettingsCached(): MiNotesSettings {
  if (!cached) cached = getSettings();
  return cached;
}
