import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent } from "@tiptap/react";
import type { Block, Property } from "../../lib/api";
import * as api from "../../lib/api";
import { useBlockEditor } from "../../editor/useBlockEditor";
import BubbleToolbar from "../../editor/BubbleToolbar";
import { parseTaskLine } from "../../lib/tasks";
import { segmentsText, inlineSegments } from "../../lib/richText";
import { showToast } from "../../lib/toast";
import { withStatus, type CardStatus } from "./kanbanModel";
import Icon from "../Icon";
import "../../editor/editor.css";

/**
 * One block in the real block editor (same TipTap extensions, markdown and
 * links as the outline). Saves on blur / unmount like an outline block.
 */
function CardBlockEditor({ block, onSaved, onOpenPage, label }: {
  block: Block;
  onSaved: () => void;
  onOpenPage: (title: string) => void;
  label: string;
}) {
  const savedRef = useRef(block.content);
  const save = useCallback((markdown: string) => {
    if (markdown === savedRef.current) return;
    savedRef.current = markdown;
    api.updateBlock(block.id, markdown).then(onSaved).catch((e) => showToast(`Couldn't save the card: ${e}`));
  }, [block.id, onSaved]);
  const edRef = useRef<{ commands: { blur: () => unknown } } | null>(null);
  const { editor } = useBlockEditor({
    content: block.content,
    onSave: save,
    onPageLinkClick: (title) => onOpenPage(title),
    // Esc leaves the editor first (it saves on blur); the next Esc closes the panel.
    onEscape: () => { edRef.current?.commands.blur(); (document.activeElement as HTMLElement | null)?.blur?.(); },
  });
  edRef.current = editor;
  return (
    <div className="kanban-card-editor-rich block-content" data-card-block={block.id} aria-label={label}>
      {editor && <BubbleToolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

const STATUSES: { value: CardStatus | null; label: string }[] = [
  { value: null, label: "None" },
  { value: "todo", label: "TODO" },
  { value: "doing", label: "DOING" },
  { value: "done", label: "DONE" },
];

/**
 * The card side panel: status, the card in the block editor, its properties
 * and its sub-items (each editable, plus "Add sub-item").
 */
export default function CardPanel({ block, pageId, blocks, onClose, onRefresh, onOpenPage }: {
  block: Block;
  pageId: string;
  blocks: Block[];
  onClose: () => void;
  onRefresh: () => void;
  onOpenPage: (title: string) => void;
}) {
  const task = parseTaskLine(block.content.split("\n")[0] ?? "");
  const status: CardStatus | null = task?.state ?? null;
  const children = blocks.filter((b) => b.parent_id === block.id);
  const [props, setProps] = useState<Property[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  // The editor owns the text while the panel is open; a status change rewrites
  // the stored block, so the editor is re-created from the new content.
  const [editorGen, setEditorGen] = useState(0);

  const loadProps = useCallback(() => {
    api.getProperties(block.id).then(setProps).catch(() => setProps([]));
  }, [block.id]);
  useEffect(loadProps, [loadProps]);

  const setStatus = useCallback(async (next: CardStatus | null) => {
    // Read the stored content: the editor may have saved since `block` was rendered.
    const tree = await api.getPageTree(pageId).catch(() => null);
    const current = tree?.blocks.find((b) => b.id === block.id)?.content ?? block.content;
    const content = withStatus(current, next);
    if (content === current) return;
    await api.updateBlock(block.id, content).catch((e) => showToast(`Couldn't change the status: ${e}`));
    setEditorGen((g) => g + 1);
    onRefresh();
  }, [block.id, block.content, pageId, onRefresh]);

  const addProp = useCallback(async () => {
    const key = newKey.trim().replace(/:+$/, "");
    if (!key) return;
    await api.setProperty(block.id, "block", key, newValue.trim()).catch((e) => showToast(`Couldn't add the property: ${e}`));
    setNewKey(""); setNewValue("");
    loadProps();
    onRefresh();
  }, [block.id, newKey, newValue, loadProps, onRefresh]);

  const removeProp = useCallback(async (key: string) => {
    await api.deleteProperty(block.id, key).catch(() => {});
    loadProps();
    onRefresh();
  }, [block.id, loadProps, onRefresh]);

  const addChild = useCallback(async () => {
    await api.createBlock(pageId, "", block.id).catch((e) => showToast(`Couldn't add a sub-item: ${e}`));
    onRefresh();
    setTimeout(() => {
      const eds = document.querySelectorAll<HTMLElement>(".kanban-side-children .ProseMirror");
      eds[eds.length - 1]?.focus();
    }, 150);
  }, [pageId, block.id, onRefresh]);

  const title = segmentsText(inlineSegments(block.content)) || "Card";
  const visibleProps = props.filter((p) => p.key !== "kanban-color" && p.key !== "collapsed");

  return (
    <div className="kanban-side-panel kanban-card-panel" role="dialog" aria-label="Card details" data-escape-scope="panel">
      <div className="kanban-side-header">
        <span className="kanban-side-title" title={title}>{title}</span>
        <button className="btn btn-sm kanban-side-open" onClick={() => onOpenPage(pageId)} title="Show this card in the page outline">
          <Icon name="page" size={13} /> In page
        </button>
        <button className="kanban-side-close" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="x" size={14} /></button>
      </div>
      <div className="kanban-side-body">
        <div className="kanban-side-label">Status</div>
        <div className="kanban-status-control" role="radiogroup" aria-label="Status">
          {STATUSES.map((s) => (
            <button
              key={s.label}
              role="radio"
              aria-checked={status === s.value}
              className={`kanban-status-opt${status === s.value ? " active" : ""}`}
              data-status={s.value ?? "none"}
              onClick={() => void setStatus(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="kanban-side-label">Card</div>
        <CardBlockEditor key={`${block.id}:${editorGen}`} block={block} onSaved={onRefresh} onOpenPage={onOpenPage} label="Card content" />

        <div className="kanban-side-label">Properties</div>
        <div className="kanban-side-props">
          {visibleProps.length === 0 && <div className="kanban-side-empty">No properties yet.</div>}
          {visibleProps.map((p) => (
            <div key={p.key} className="kanban-side-prop" data-key={p.key}>
              <span className="kanban-side-prop-key">{p.key}</span>
              <span className="kanban-side-prop-value">{p.value}</span>
              <button className="kanban-col-btn" onClick={() => void removeProp(p.key)} aria-label={`Remove ${p.key}`} title={`Remove ${p.key}`}><Icon name="x" size={12} /></button>
            </div>
          ))}
          <form className="kanban-side-prop-add" onSubmit={(e) => { e.preventDefault(); void addProp(); }}>
            <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="due" aria-label="Property name" />
            <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="2026-11-02" aria-label="Property value" />
            <button className="btn btn-sm" type="submit" disabled={!newKey.trim()} title={newKey.trim() ? "Add the property" : "Type a property name first"}>Add</button>
          </form>
        </div>

        <div className="kanban-side-label">Sub-items</div>
        <div className="kanban-side-children">
          {children.map((c) => (
            <CardBlockEditor key={c.id} block={c} onSaved={onRefresh} onOpenPage={onOpenPage} label="Sub-item" />
          ))}
          <button className="btn btn-sm kanban-side-add-child" onClick={() => void addChild()}>
            <Icon name="plus" size={13} /> Add sub-item
          </button>
        </div>
      </div>
    </div>
  );
}
