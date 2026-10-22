import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import Icon from "../components/Icon";
import { promptDialog } from "../lib/confirm";
import { showToast } from "../lib/toast";
import { normalizeUrl } from "./slashCommands";

interface Props {
  editor: Editor;
}

/**
 * The formatting bubble over a text selection. It sits above the selection and
 * flips below it when there's no room (the first block, right under the page
 * header — UX Wave 4: it used to be clipped there). Link asks for an address;
 * on a link it removes it.
 */
export default function BubbleToolbar({ editor }: Props) {
  if (!editor) return null;

  const link = async () => {
    if (editor.isActive("link")) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const { from, to } = editor.state.selection;
    const value = await promptDialog({
      title: "Link the selected text",
      label: "Web address",
      placeholder: "https://example.com",
      confirmLabel: "Link",
    });
    if (editor.isDestroyed) return;
    if (value === null) { editor.commands.focus(); return; }
    const href = normalizeUrl(value);
    if (!href) { showToast(`“${value}” isn't a web address`); editor.commands.focus(); return; }
    editor.chain().focus().setTextSelection({ from, to }).setLink({ href }).run();
  };

  return (
    <BubbleMenu
      editor={editor}
      className="bubble-menu"
      options={{
        placement: "top",
        // Keep clear of the page header above the scroll area: flip below instead.
        flip: { padding: { top: 56 }, fallbackPlacements: ["bottom"] },
        shift: { padding: 8 },
      }}
      shouldShow={({ state }) => {
        // Don't show in code blocks
        const { $from } = state.selection;
        if ($from.node($from.depth).type.name === "codeBlock") return false;
        // Only show when there's a text selection
        return !state.selection.empty;
      }}
    >
      <div className="bubble-toolbar" role="toolbar" aria-label="Formatting">
        <button
          className={editor.isActive("bold") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
          title="Bold (Ctrl+B)"
          aria-label="Bold"
        >
          B
        </button>
        <button
          className={editor.isActive("italic") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
          title="Italic (Ctrl+I)"
          aria-label="Italic"
        >
          <em>I</em>
        </button>
        <button
          className={editor.isActive("strike") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleStrike().run(); }}
          title="Strikethrough (Ctrl+Shift+S)"
          aria-label="Strikethrough"
        >
          <s>S</s>
        </button>
        <button
          className={editor.isActive("code") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleCode().run(); }}
          title="Inline code (Ctrl+E)"
          aria-label="Inline code"
        >
          <Icon name="code" size={15} />
        </button>
        <button
          className={editor.isActive("highlight") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHighlight().run(); }}
          title="Highlight (Ctrl+Shift+H)"
          aria-label="Highlight"
          data-action="highlight"
        >
          <Icon name="highlighter" size={15} />
        </button>
        <button
          className={editor.isActive("link") ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); void link(); }}
          title={editor.isActive("link") ? "Remove the link" : "Link…"}
          aria-label={editor.isActive("link") ? "Remove link" : "Link"}
          data-action="link"
        >
          <Icon name="link" size={15} />
        </button>
        <span className="bubble-separator" />
        <button
          className={editor.isActive("heading", { level: 1 }) ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 1 }).run(); }}
          title="Heading 1"
          aria-label="Heading 1"
        >
          H1
        </button>
        <button
          className={editor.isActive("heading", { level: 2 }) ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 2 }).run(); }}
          title="Heading 2"
          aria-label="Heading 2"
        >
          H2
        </button>
        <button
          className={editor.isActive("heading", { level: 3 }) ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 3 }).run(); }}
          title="Heading 3"
          aria-label="Heading 3"
        >
          H3
        </button>
      </div>
    </BubbleMenu>
  );
}
