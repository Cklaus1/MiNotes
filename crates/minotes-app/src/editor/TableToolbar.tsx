import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { TABLE_ACTIONS, isInTable, type TableAction } from "./tables";

interface Props {
  editor: Editor;
  /** Runs a structure command and persists the result. */
  onAction: (action: TableAction) => void;
}

/** Floating table-structure toolbar, pinned above the table while the cursor is in it. */
export default function TableToolbar({ editor, onAction }: Props) {
  if (!editor) return null;

  const tableRect = () => {
    const { from } = editor.state.selection;
    let el: Node | null = editor.view.domAtPos(from).node;
    while (el && !(el instanceof HTMLElement && el.tagName === "TABLE")) el = el.parentNode;
    return el ? (el as HTMLElement).getBoundingClientRect() : null;
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableToolbar"
      shouldShow={({ state, view }) => view.hasFocus() && isInTable(state)}
      getReferencedVirtualElement={() => {
        const r = tableRect();
        return r ? { getBoundingClientRect: () => tableRect() ?? r } : null;
      }}
      options={{ placement: "top-start", offset: 6 }}
    >
      <div className="table-toolbar" role="toolbar" aria-label="Table">
        {TABLE_ACTIONS.map(({ action, label, short, danger }, i) => (
          <span key={action} style={{ display: "contents" }}>
            {(i === 4 || i === 6) && <span className="bubble-separator" />}
            <button
              className={danger ? "danger" : undefined}
              data-table-action={action}
              title={label}
              aria-label={label}
              onMouseDown={(e) => { e.preventDefault(); onAction(action); }}
            >
              {short}
            </button>
          </span>
        ))}
      </div>
    </BubbleMenu>
  );
}
