interface UndoAction {
  type: 'create' | 'delete' | 'update' | 'merge' | 'split' | 'reparent';
  blockId: string;
  pageId: string;
  oldContent?: string;
  newContent?: string;
  oldParentId?: string | null;
  newParentId?: string | null;
  deletedBlock?: { content: string; parentId?: string; position: number };
  mergedFromId?: string;
  mergedContent?: string;
  timestamp: number;
}

class UndoStack {
  private undoStack: UndoAction[] = [];
  private redoStack: UndoAction[] = [];
  private maxSize = 100;

  push(action: UndoAction) {
    this.undoStack.push(action);
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  popUndo(): UndoAction | undefined {
    const action = this.undoStack.pop();
    if (action) this.redoStack.push(action);
    return action;
  }

  popRedo(): UndoAction | undefined {
    const action = this.redoStack.pop();
    if (action) this.undoStack.push(action);
    return action;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

export const undoStack = new UndoStack();
export type { UndoAction };
