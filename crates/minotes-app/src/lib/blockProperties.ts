/**
 * Block properties, loaded in batches.
 *
 * Every BlockItem shows its properties; asking the backend once per block made
 * opening a 2,000-block page cost 2,000 `get_properties` calls. Instead:
 *  - PageView prefetches the whole page in ONE `get_properties_batch` call
 *    (`prefetchBlockProperties`), before its blocks' effects run;
 *  - a block not covered by a prefetch (created later, re-mounted) is queued and
 *    fetched together with every other block that asked in the same tick.
 * A prefetched answer is used once (by the block's first load) and then
 * forgotten, so a block that mounts again later reads fresh values.
 */
import * as api from "./api";
import type { Property } from "./api";

type Props = Property[];
const PREFETCH_TTL_MS = 30_000;

/** id -> prefetched (or in-flight) properties, consumed by the first load. */
const prefetched = new Map<string, { at: number; value: Promise<Props> }>();
/** ids waiting for the next batched fetch. */
let queue = new Map<string, { resolve: (p: Props) => void }[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function fetchBatch(ids: string[]): Promise<Record<string, Props>> {
  try {
    return await api.getPropertiesBatch(ids);
  } catch {
    // A backend without the batch command: fall back to one call per id.
    const out: Record<string, Props> = {};
    await Promise.all(ids.map(async (id) => {
      try { out[id] = await api.getProperties(id); } catch { /* none */ }
    }));
    return out;
  }
}

function flush() {
  flushTimer = null;
  const batch = queue;
  queue = new Map();
  const ids = [...batch.keys()];
  if (ids.length === 0) return;
  fetchBatch(ids).then((map) => {
    for (const [id, waiters] of batch) for (const w of waiters) w.resolve(map[id] ?? []);
  });
}

/** Fetch the properties of all these blocks in one call (page open). */
export function prefetchBlockProperties(ids: string[]) {
  if (ids.length === 0) return;
  const now = Date.now();
  for (const [id, e] of prefetched) if (now - e.at > PREFETCH_TTL_MS) prefetched.delete(id);
  const all = fetchBatch(ids);
  for (const id of ids) prefetched.set(id, { at: now, value: all.then((m) => m[id] ?? []) });
}

/** This block's properties: from the page prefetch, else batched with other loads. */
export function loadBlockProperties(id: string): Promise<Props> {
  const pre = prefetched.get(id);
  if (pre) {
    prefetched.delete(id);
    if (Date.now() - pre.at <= PREFETCH_TTL_MS) return pre.value;
  }
  return new Promise<Props>((resolve) => {
    const waiters = queue.get(id) ?? [];
    waiters.push({ resolve });
    queue.set(id, waiters);
    if (!flushTimer) flushTimer = setTimeout(flush, 0);
  });
}

/** Another notebook was opened: prefetched answers belong to the old one
 *  (a copied or zip-imported notebook can share block ids). */
export function clearPrefetchedProperties() {
  prefetched.clear();
}
