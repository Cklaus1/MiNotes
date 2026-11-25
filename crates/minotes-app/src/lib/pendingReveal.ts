/**
 * A block to reveal (scroll to, highlight, focus) once the page it is on has
 * opened: set before navigating — a ((block ref)) click, a search result in
 * another notebook — and taken by PageView when that page renders.
 */
let pending: string | null = null;

export function setPendingReveal(blockId: string | null) {
  pending = blockId;
}

/** The pending block if it is among `blockIds` (and forget it), else null. */
export function takePendingReveal(blockIds: Iterable<string>): string | null {
  if (!pending) return null;
  for (const id of blockIds) {
    if (id === pending) {
      pending = null;
      return id;
    }
  }
  return null;
}
