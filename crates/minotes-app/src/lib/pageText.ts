import type { Block } from "./api";

/** Blocks of a page as plain text in outline order, children indented two spaces. */
export function pageAsText(blocks: Block[]): string {
  const children = new Map<string | null, Block[]>();
  for (const b of blocks) {
    const k = b.parent_id ?? null;
    if (!children.has(k)) children.set(k, []);
    children.get(k)!.push(b);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const b of children.get(parent) ?? []) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push("  ".repeat(depth) + b.content);
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  // Blocks whose parent isn't on the page: keep them rather than drop text.
  for (const b of blocks) if (!seen.has(b.id)) out.push(b.content);
  return out.join("\n");
}
