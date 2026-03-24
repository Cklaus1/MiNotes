import { undoStack } from './undoStack';
import * as api from './api';

export async function executeUndo(): Promise<boolean> {
  const action = undoStack.popUndo();
  if (!action) return false;

  switch (action.type) {
    case 'create':
      await api.deleteBlock(action.blockId);
      break;
    case 'delete':
      if (action.deletedBlock) {
        await api.createBlock(
          action.pageId,
          action.deletedBlock.content,
          action.deletedBlock.parentId
        );
      }
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

  switch (action.type) {
    case 'create':
      await api.createBlock(action.pageId, action.newContent ?? '', undefined);
      break;
    case 'delete':
      await api.deleteBlock(action.blockId);
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
