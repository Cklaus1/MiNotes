import { undoStack } from './undoStack';
import type { RestoreBlock } from './api';
import * as api from './api';

/** Roots of a restore batch: blocks whose parent is not itself in the batch. */
function restoreRoots(blocks: RestoreBlock[]): string[] {
  const ids = new Set(blocks.map(b => b.id));
  return blocks.filter(b => !b.parent_id || !ids.has(b.parent_id)).map(b => b.id);
}

/**
 * Tell views that undo/redo rewrote these blocks server-side, so any optimistic
 * "recently deleted/edited" bookkeeping for them is stale and the next fetched
 * tree must win (PageView listens).
 */
function notifyTouched(action: { blockId: string; restore?: RestoreBlock[] }) {
  const ids = [action.blockId, ...(action.restore ?? []).map(b => b.id)];
  window.dispatchEvent(new CustomEvent("minotes-undo-applied", { detail: { ids } }));
}

export async function executeUndo(): Promise<boolean> {
  const action = undoStack.popUndo();
  if (!action) return false;
  notifyTouched(action);

  switch (action.type) {
    case 'create':
      await api.deleteBlock(action.blockId);
      break;
    case 'delete':
      // Original ids, parents, positions and properties come back in one call.
      if (action.restore?.length) await api.restoreBlocks(action.restore);
      break;
    case 'merge':
      // blockId is the block that absorbed the merged one: un-merge its text,
      // then bring the merged block (and its subtree) back.
      if (action.oldContent !== undefined) await api.updateBlock(action.blockId, action.oldContent);
      if (action.restore?.length) await api.restoreBlocks(action.restore);
      for (const c of action.movedChildren ?? []) await api.moveBlock(c.id, c.fromParentId, c.fromPosition);
      break;
    case 'update':
      if (action.oldContent !== undefined) {
        await api.updateBlock(action.blockId, action.oldContent);
      }
      break;
    case 'reparent':
      await api.reparentBlock(action.blockId, action.oldParentId ?? undefined);
      break;
  }
  return true;
}

export async function executeRedo(): Promise<boolean> {
  const action = undoStack.popRedo();
  if (!action) return false;
  notifyTouched(action);

  switch (action.type) {
    case 'create':
      await api.createBlock(action.pageId, action.newContent ?? '', undefined);
      break;
    case 'delete':
      for (const id of restoreRoots(action.restore ?? [])) await api.deleteBlock(id);
      break;
    case 'merge':
      if (action.newContent !== undefined) await api.updateBlock(action.blockId, action.newContent);
      // Re-home the children first: deleting the merged block cascades.
      for (const c of action.movedChildren ?? []) await api.moveBlock(c.id, c.toParentId, c.toPosition);
      for (const id of restoreRoots(action.restore ?? [])) await api.deleteBlock(id);
      break;
    case 'update':
      if (action.newContent !== undefined) {
        await api.updateBlock(action.blockId, action.newContent);
      }
      break;
    case 'reparent':
      await api.reparentBlock(action.blockId, action.newParentId ?? undefined);
      break;
  }
  return true;
}
