/**
 * Save barrier: `flushPendingEdits()` commits every unsaved edit in the UI and
 * waits until the writes have reached the backend.
 *
 * Why: editors save on blur / unmount and whiteboards on a debounce. Anything
 * that swaps the backend's database under the UI (switching notebooks) must run
 * this first, or those late saves land in the OTHER notebook — a block id that
 * doesn't exist there (lost edit) or a whiteboard row nothing references (GC'd).
 *
 * Participants:
 *  - live block editors, via lib/editorActivation (`flushEditors`): a dirty
 *    editor saves its current content now (the same `saveNow` as structural
 *    edits, so the dirty flag is respected and nothing saves twice);
 *  - anything registered with `registerFlush` (whiteboards, PageView's op queue,
 *    App's "add the whiteboard block" step): returns a promise that settles when
 *    its writes are done, and rejects if they failed;
 *  - writes tracked with `trackWrite` (block content saves): awaited, and a
 *    failure fails the barrier.
 * Rounds repeat until nothing new was started (a whiteboard save can start the
 * block create that references it), bounded by a timeout.
 */
import { flushEditors } from "./editorActivation";
import { errorMessage } from "./errors";

type Flush = () => Promise<unknown> | void;

const flushes = new Set<Flush>();
const inflight = new Set<Promise<unknown>>();

/** Take part in the barrier. Returns the unregister function. */
export function registerFlush(fn: Flush): () => void {
  flushes.add(fn);
  return () => { flushes.delete(fn); };
}

/** A backend write the barrier must wait for (returns `p` unchanged). */
export function trackWrite<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  const done = () => { inflight.delete(p); };
  p.then(done, done);
  return p;
}

const MAX_ROUNDS = 5;

async function flushAll(): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Synchronously commit what editors hold; their saves become tracked writes.
    flushEditors();
    const results = await Promise.allSettled([...flushes].map(f => f()));
    const writes = await Promise.allSettled([...inflight]);
    const failed = [...results, ...writes].find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    // Done when this round found nothing to wait for (and nothing new started).
    if (writes.length === 0 && inflight.size === 0) return;
  }
}

/**
 * Save everything the UI hasn't saved yet; resolves once it is in the backend.
 * Rejects (with a user-facing message) if a save failed or took longer than
 * `timeoutMs` — callers must then NOT switch the database. Cheap when nothing
 * is dirty: a few no-op calls and one microtask round.
 */
export async function flushPendingEdits(timeoutMs = 3000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("still saving your changes — try again in a moment")), timeoutMs);
  });
  try {
    await Promise.race([
      flushAll().catch((e) => { throw new Error(`your last changes couldn't be saved (${errorMessage(e)})`); }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
