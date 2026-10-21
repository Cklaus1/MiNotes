/**
 * "New page" (Ctrl+N, the palette): the sidebar's own "+ New" field when the
 * sidebar can show it, otherwise the app's prompt dialog — never the
 * platform's `prompt()` (a bare GTK dialog in the desktop app).
 */
import { promptDialog } from "./confirm";

/** Cancelable window event; the sidebar calls preventDefault when it opens its field. */
export const NEW_PAGE_FIELD_EVENT = "minotes:new-page-field";

/**
 * Ask for a new page's title. Resolves to the title for the caller to create,
 * or null when the sidebar's field took over (it creates the page itself) or
 * the prompt was cancelled.
 */
export async function askNewPage(): Promise<string | null> {
  const handled = !window.dispatchEvent(new CustomEvent(NEW_PAGE_FIELD_EVENT, { cancelable: true }));
  if (handled) return null;
  return promptDialog({ title: "New page", label: "Page title", placeholder: "Untitled", confirmLabel: "Create page" });
}
