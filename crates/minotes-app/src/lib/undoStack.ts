import type { RestoreBlock } from './api';

/** One block indented / outdented: where it was and where it went (null parent = top level). */
interface UndoMove {
  id: string;
  fromParentId: string | null;
  fromPosition: number;
  toParentId: string | null;
  toPosition: number;
}

interface UndoAction {
  type: 'create' | 'delete' | 'update' | 'merge' | 'reparent' | 'move' | 'outside-import' | 'conflict-resolve';
  blockId: string;
  pageId: string;
  oldContent?: string;
  newContent?: string;
  oldParentId?: string | null;
  newParentId?: string | null;
  /**
   * 'delete' / 'merge': every deleted block (each deleted root plus its whole
   * subtree, parents-first, with properties). Undo recreates them in one call
   * with their ORIGINAL ids, parents and positions; redo deletes the roots.
   */
  restore?: RestoreBlock[];
  /**
   * 'merge': children of the merged block, re-homed onto the block that absorbed
   * it (so the merge doesn't cascade-delete them). Undo moves them back under the
   * restored block; redo re-homes them again before deleting it.
   */
  movedChildren?: { id: string; fromParentId: string; fromPosition: number; toParentId: string; toPosition: number }[];
  /**
   * 'move': blocks indented / outdented in one step (Tab, Shift+Tab, Enter on an
   * empty nested block, Backspace at its start, Tab on a selection). Undo puts
   * them back in reverse order; redo applies them again in order.
   */
  moves?: UndoMove[];
  /**
   * 'outside-import': a file of the markdown copy edited in another program was
   * imported into the page. Undo sets the page's blocks back to `before`; redo
   * to `after`. `parkedPageId` is the Trash page holding blocks whose lines the
   * file removed (removed once empty); `pageTitle` names the next one on redo.
   */
  before?: RestoreBlock[];
  after?: RestoreBlock[];
  parkedPageId?: string | null;
  pageTitle?: string;
  /**
   * 'conflict-resolve': a sync conflict copy was resolved into `pageId` (whose
   * blocks were `before` and became `after`) and moved to the Trash. Undo sets
   * the page back and brings `copyId` back; redo applies it again.
   */
  copyId?: string;
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
  /** The action the next undo would take (not removed). */
  peekUndo(): UndoAction | undefined { return this.undoStack[this.undoStack.length - 1]; }
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
export type { UndoAction, UndoMove };
