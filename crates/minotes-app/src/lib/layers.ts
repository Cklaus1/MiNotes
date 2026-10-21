/**
 * Open layers and the app-wide Esc rule (UX Wave 3).
 *
 * Everything that floats above the page registers here while it is open, with
 * its kind. **Esc closes only the topmost layer**: the highest kind first
 * (popover > menu > dialog > side panel > canvas overlay), the most recently
 * opened one among equals — never two at once.
 *
 * The decision is made after every other keydown listener has run (deferred):
 * if something already used this Escape — a field cancelling its own edit, the
 * editor, a suggestion popup, a canvas leaving a tool mode — it calls
 * preventDefault and nothing closes. A layer opened without a close function
 * (a screen that must not be lost to a stray key) swallows Escape.
 *
 * Views with their own Escape handling (canvases) check `coveredAbove(kind)`
 * first and leave the key alone while a higher layer is open.
 *
 * The confirm dialog (lib/confirm.ts) sits above all of this: it captures
 * every key while it is open.
 */
import { useEffect, useRef } from "react";

export type LayerKind = "popover" | "menu" | "dialog" | "panel" | "canvas";

const RANK: Record<LayerKind, number> = { canvas: 1, panel: 2, dialog: 3, menu: 4, popover: 5 };

interface Layer {
  id: number;
  kind: LayerKind;
  close: (() => void) | null;
}

const layers: Layer[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function changed() {
  for (const l of listeners) l();
}

/** The layer Esc would close now (or undefined). */
export function topLayer(): { kind: LayerKind } | undefined {
  let top: Layer | undefined;
  for (const l of layers) {
    if (!top || RANK[l.kind] > RANK[top.kind] || (RANK[l.kind] === RANK[top.kind] && l.id > top.id)) top = l;
  }
  return top;
}

/** Is any layer of these kinds open (any kind when omitted)? */
export function hasOpenLayer(kinds?: LayerKind[]): boolean {
  return layers.some(l => !kinds || kinds.includes(l.kind));
}

/** Is a layer of a higher kind than `kind` open (so Escape belongs to it)? */
export function coveredAbove(kind: LayerKind): boolean {
  return layers.some(l => RANK[l.kind] > RANK[kind]);
}

/** Notified whenever a layer opens or closes. */
export function onLayersChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Register a layer; returns its unregister function. */
export function openLayer(kind: LayerKind, close: (() => void) | null): () => void {
  install();
  const entry: Layer = { id: nextId++, kind, close };
  layers.push(entry);
  changed();
  return () => {
    const i = layers.findIndex(x => x.id === entry.id);
    if (i >= 0) { layers.splice(i, 1); changed(); }
  };
}

/**
 * Register a layer while `active`. Esc calls `close` when it is the topmost
 * layer; pass `null` for a layer Esc must not close (it still swallows Esc).
 */
export function useLayer(active: boolean, kind: LayerKind, close: (() => void) | null): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const closable = close !== null;
  useEffect(() => {
    if (!active) return;
    return openLayer(kind, closable ? () => closeRef.current?.() : null);
  }, [active, kind, closable]);
}

const yielded = new WeakSet<Event>();

/**
 * For a handler that leaves this Escape to the layers even though its widget
 * will still call preventDefault (ProseMirror always does for Escape).
 */
export function yieldEscape(e: Event): void {
  yielded.add(e);
}

/** Mark an Escape as handled so no layer closes. */
export function consumeEscape(e: { key: string; preventDefault: () => void }): void {
  if (e.key === "Escape") e.preventDefault();
}

let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" && e.key !== "Esc") return;
    if (e.isComposing) return;
    // A field that handles Escape itself (an inline rename) keeps it.
    if ((e.target as HTMLElement | null)?.closest?.("[data-escape-local]")) return;
    // Let every other listener (React handlers, window listeners registered
    // later, ProseMirror keymaps) see the event first.
    setTimeout(() => {
      if (e.defaultPrevented && !yielded.has(e)) return;
      const top = topLayer() as Layer | undefined;
      if (top?.close) top.close();
    }, 0);
  });
}

/** Test-only: what is open, bottom to top by Esc order. */
export function debugLayers(): string[] {
  return [...layers]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.id - b.id)
    .map(l => l.kind);
}
