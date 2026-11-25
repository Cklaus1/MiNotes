/**
 * Test hook for the Import dialog's pickers (native dialogs can't be driven by
 * automation): the next "Choose…" returns these paths (null = cancelled).
 */
let next: string[] | null | undefined;

export function setNextImportPick(paths: string[] | string | null) {
  next = paths === null ? null : Array.isArray(paths) ? paths : [paths];
}

/** undefined when no pick is queued. */
export function takeNextImportPick(): string[] | null | undefined {
  const p = next;
  next = undefined;
  return p;
}

/** Ask the app to open the Import dialog (File → Import…, notebook menu, empty state). */
export const OPEN_IMPORT = "minotes:open-import";
export function openImport(kind?: "obsidian" | "evernote" | "markdown") {
  window.dispatchEvent(new CustomEvent(OPEN_IMPORT, { detail: kind }));
}
