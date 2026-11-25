/**
 * Escape-to-close for views without Escape handling of their own — a thin
 * wrapper over the app-wide layer registry (lib/layers.ts): Esc closes only the
 * topmost layer, and only when nothing else used the key.
 */
import { useLayer, type LayerKind } from "./layers";
export { consumeEscape } from "./layers";

/** Register `close` while `active`; Escape calls it when it is the topmost layer. */
export function useEscapeToClose(active: boolean, close: () => void, kind: LayerKind = "panel"): void {
  useLayer(active, kind, close);
}
