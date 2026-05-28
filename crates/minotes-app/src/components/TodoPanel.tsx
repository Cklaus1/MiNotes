import { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";
import { extractTodos } from "../lib/todoExtractor";

interface Props {
  pageTree: api.PageTree;
  onUpdateBlock: (id: string, content: string) => void;
  onPageClick: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}

export default function TodoPanel({
  pageTree,
  onUpdateBlock,
  onPageClick,
  collapsed,
  onToggle,
}: Props) {
  const [todos, setTodos] = useState<
    Array<{ item: ReturnType<typeof extractTodos>[0]; page: api.Page }>
  >([]);
  const [pendingCount, setPendingCount] = useState(0);

  const refresh = useCallback(() => {
    const allTodos: Array<{
      item: ReturnType<typeof extractTodos>[0];
      page: api.Page;
    }> = [];

    for (const block of pageTree.blocks) {
      const extracted = extractTodos([block], pageTree.page.id);
      for (const todo of extracted) {
        allTodos.push({ item: todo, page: pageTree.page });
      }
    }

    setTodos(allTodos);
    setPendingCount(allTodos.filter((t) => !t.item.done).length);
  }, [pageTree]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = async (todo: {
    item: ReturnType<typeof extractTodos>[0];
    page: api.Page;
  }) => {
    const block = pageTree.blocks.find((b) => b.id === todo.item.sourceBlockId);
    if (!block) return;

    const lines = block.content.split("\n");
    const lineIdx = todo.item.sourceBlockIndex;
    if (lineIdx >= lines.length) return;

    const line = lines[lineIdx];
    const checkboxRegex = /^\s*([-*])\s+\[([ xX])\]\s+(.*)/;
    const match = line.match(checkboxRegex);
    if (match) {
      const newCheck = todo.item.done ? " " : "x";
      lines[lineIdx] = `${match[1]} [${newCheck}] ${match[3]}`;
      const newContent = lines.join("\n");
      await onUpdateBlock(todo.item.sourceBlockId, newContent);
      refresh();
    }
  };

  if (collapsed) {
    return (
      <div className="todo-panel-collapsed" onClick={onToggle} title="View TODOs">
        TODOs ({pendingCount})
      </div>
    );
  }

  return (
    <div className="todo-panel">
      <div className="todo-panel-header">
        <h4>TODOs ({pendingCount} pending)</h4>
        <button className="todo-close" onClick={onToggle} title="Close">
          x
        </button>
      </div>
      {todos.length === 0 ? (
        <p className="todo-empty">No TODOs found.</p>
      ) : (
        <div className="todo-list">
          {todos
            .filter((t) => !t.item.done)
            .map((t) => (
              <div
                key={t.item.id}
                className="todo-item"
                onClick={() => onPageClick(t.item.sourceBlockId)}
              >
                <button
                  className="todo-check"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggle(t);
                  }}
                  title="Mark as done"
                >
                  {"["}{" "}
                </button>
                <span className="todo-text">{t.item.text}</span>
                <span className="todo-source">
                  {" "}
                  — {t.page.title}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}