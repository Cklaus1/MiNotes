import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";

interface Props {
  editor: Editor;
}

export default function BubbleToolbar({ editor }: Props) {
  if (!editor) return null;

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ state }) => {
        // Don't show in code blocks
        const { $from } = state.selection;
        if ($from.node($from.depth).type.name === "codeBlock") return false;
        // Only show when there's a text selection
        return !state.selection.empty;
      }}
    >
      <div className="bubble-toolbar">
        <button
          className={editor.isActive("bold") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
          title="Bold (Ctrl+B)"
        >
          B
        </button>
        <button
          className={editor.isActive("italic") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
          title="Italic (Ctrl+I)"
        >
          <em>I</em>
        </button>
        <button
          className={editor.isActive("strike") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleStrike().run(); }}
          title="Strikethrough"
        >
          <s>S</s>
        </button>
        <button
          className={editor.isActive("code") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleCode().run(); }}
          title="Inline Code (Ctrl+E)"
        >
          {"<>"}
        </button>
        <span className="bubble-separator" />
        <button
          className={editor.isActive("highlight") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHighlight().run(); }}
          title="Highlight"
        >
          H
        </button>
        <span className="bubble-separator" />
        <button
          className={editor.isActive("heading", { level: 1 }) ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 1 }).run(); }}
          title="Heading 1"
        >
          H1
        </button>
        <button
          className={editor.isActive("heading", { level: 2 }) ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 2 }).run(); }}
          title="Heading 2"
        >
          H2
        </button>
        <button
          className={editor.isActive("heading", { level: 3 }) ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 3 }).run(); }}
          title="Heading 3"
        >
          H3
        </button>
      </div>
    </BubbleMenu>
  );
}
