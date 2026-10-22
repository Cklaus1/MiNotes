/** Rows per "page" of the backlinks / unlinked mentions lists (more on request). */
export const BACKLINK_PAGE_SIZE = 50;

export interface PageGroup<T> {
  pageId: string;
  title: string;
  items: T[];
}

/** Items grouped by their page, groups in order of first appearance. */
export function groupByPage<T>(items: T[], pageOf: (t: T) => string, titleOf: (t: T) => string): PageGroup<T>[] {
  const byPage = new Map<string, PageGroup<T>>();
  for (const it of items) {
    const id = pageOf(it);
    let g = byPage.get(id);
    if (!g) { g = { pageId: id, title: titleOf(it) || "(untitled)", items: [] }; byPage.set(id, g); }
    g.items.push(it);
  }
  return [...byPage.values()];
}
