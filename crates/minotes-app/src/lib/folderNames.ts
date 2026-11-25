import * as api from "./api";
import type { FolderTree } from "./api";

/**
 * Two projects with the same name next to each other are indistinguishable in
 * the sidebar and in every "Move to…" list, so the UI refuses them. Comparison
 * is case-insensitive and ignores surrounding whitespace. Returns a user-facing
 * message when `name` is taken by a sibling (other than `excludeId`), else null.
 */
export async function folderNameConflict(
  name: string,
  parentId: string | null,
  excludeId?: string,
): Promise<string | null> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  let tree: api.FolderTreeRoot;
  try {
    tree = await api.getFolderTree();
  } catch {
    return null; // can't check — let the backend decide
  }
  const siblingsOf = (folders: FolderTree[]): FolderTree[] | null => {
    if (parentId === null) return folders;
    for (const f of folders) {
      if (f.id === parentId) return f.children ?? [];
      const found = siblingsOf(f.children ?? []);
      if (found) return found;
    }
    return null;
  };
  const siblings = siblingsOf(tree.folders ?? []) ?? [];
  const clash = siblings.find(f => f.id !== excludeId && f.name.trim().toLowerCase() === wanted);
  return clash ? `A project named "${clash.name}" already exists` : null;
}

/** Parent id of a folder in the tree (null for top level / unknown). */
export async function folderParentId(folderId: string): Promise<string | null> {
  try {
    const tree = await api.getFolderTree();
    const walk = (folders: FolderTree[], parent: string | null): string | null | undefined => {
      for (const f of folders) {
        if (f.id === folderId) return parent;
        const r = walk(f.children ?? [], f.id);
        if (r !== undefined) return r;
      }
      return undefined;
    };
    return walk(tree.folders ?? [], null) ?? null;
  } catch {
    return null;
  }
}
