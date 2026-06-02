/**
 * Extracts TODO items from markdown content.
 * No external dependencies — pure TypeScript.
 */

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  sourcePageId: string;
  sourceBlockId: string;
  sourceBlockIndex: number;
}

/**
 * Extract TODOs from a single block.
 * Recognizes: - [ ], - [x], TODO:, Action:, Follow up:, Next:
 */
export function extractTodosFromBlock(
  content: string,
  blockId: string,
  pageId: string,
  index: number,
): TodoItem[] {
  const todos: TodoItem[] = [];
  const lines = content.split("\n");

  const checkboxRegex = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)/;
  const actionRegex = /^\s*(TODO|ACTION|FOLLOW UP|NEXT|FOLLOW-UP):\s*(.*)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Checkbox pattern: - [ ] or - [x]
    const checkboxMatch = trimmed.match(checkboxRegex);
    if (checkboxMatch) {
      const done = checkboxMatch[1].toLowerCase() === "x";
      const text = checkboxMatch[2].trim();
      if (text.length > 0) {
        todos.push({
          id: `${blockId}-${i}`,
          text,
          done,
          sourcePageId: pageId,
          sourceBlockId: blockId,
          sourceBlockIndex: index,
        });
      }
      continue;
    }

    // Action keyword pattern: TODO:, Action:, etc.
    const actionMatch = trimmed.match(actionRegex);
    if (actionMatch) {
      const text = actionMatch[2].trim();
      if (text.length > 0) {
        todos.push({
          id: `${blockId}-action-${i}`,
          text,
          done: false,
          sourcePageId: pageId,
          sourceBlockId: blockId,
          sourceBlockIndex: index,
        });
      }
    }
  }

  return todos;
}

/**
 * Extract TODOs from all blocks of a page.
 */
export function extractTodos(
  blocks: { id: string; content: string }[],
  pageId: string,
): TodoItem[] {
  const allTodos: TodoItem[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const todos = extractTodosFromBlock(block.content, block.id, pageId, i);
    allTodos.push(...todos);
  }

  return allTodos;
}

/**
 * Extract TODOs from a single string of content.
 */
export function extractTodosFromString(
  content: string,
  blockId: string,
  pageId: string,
): TodoItem[] {
  return extractTodosFromBlock(content, blockId, pageId, 0);
}