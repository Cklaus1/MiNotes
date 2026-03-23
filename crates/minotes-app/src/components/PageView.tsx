import { useState, useRef, useCallback, useEffect } from "react";
import type { PageTree, Property } from "../lib/api";
import * as api from "../lib/api";
import BlockItem from "./BlockItem";
import BacklinksPanel from "./BacklinksPanel";

interface Props {
  pageTree: PageTree;
  onCreateBlock: (content: string) => void;
  onUpdateBlock: (id: string, content: string) => void;
  onDeleteBlock: (id: string) => void;
  onPageLinkClick: (title: string) => void;
}

export default function PageView({
  pageTree, onCreateBlock, onUpdateBlock, onDeleteBlock, onPageLinkClick,
}: Props) {
  const { page, blocks } = pageTree;
  const [newContent, setNewContent] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [pageProps, setPageProps] = useState<Property[]>([]);
  const [showProps, setShowProps] = useState(false);
  const [addingProp, setAddingProp] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingProp, setEditingProp] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Load page properties
  useEffect(() => {
    api.getProperties(page.id).then(props => {
      setPageProps(props);
      if (props.length > 0) setShowProps(true);
    }).catch(() => {});
  }, [page.id]);

  const handleAdd = useCallback(() => {
    if (newContent.trim()) {
      onCreateBlock(newContent.trim());
      setNewContent("");
      inputRef.current?.focus();
    }
  }, [newContent, onCreateBlock]);

  const handleAddPageProp = async () => {
    const k = newKey.trim();
    const v = newValue.trim();
    if (!k) return;
    await api.setProperty(page.id, "page", k, v);
    const props = await api.getProperties(page.id);
    setPageProps(props);
    setNewKey("");
    setNewValue("");
    setAddingProp(false);
  };

  const handleUpdatePageProp = async (key: string) => {
    await api.setProperty(page.id, "page", key, editValue.trim());
    const props = await api.getProperties(page.id);
    setPageProps(props);
    setEditingProp(null);
  };

  const handleDeletePageProp = async (key: string) => {
    await api.deleteProperty(page.id, key);
    setPageProps(prev => prev.filter(p => p.key !== key));
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  return (
    <>
      <div className="main-header">
        <h2>{page.icon ?? (page.is_journal ? "📅" : "")} {page.title}</h2>
        <span className="page-meta">
          {blocks.length} blocks · Updated {formatDate(page.updated_at)}
          <button
            className="prop-toggle-btn"
            onClick={() => setShowProps(p => !p)}
            title="Toggle properties"
          >
            ⚙
          </button>
        </span>
      </div>

      {showProps && (
        <div className="page-properties">
          <div className="page-properties-header">
            <span className="page-properties-label">Properties</span>
            <button
              className="prop-add-btn"
              onClick={() => setAddingProp(true)}
              title="Add property"
            >
              +
            </button>
          </div>
          <div className="page-properties-list">
            {pageProps.map(prop => (
              <div key={prop.key} className="page-prop-row">
                <span className="prop-key">{prop.key}</span>
                {editingProp === prop.key ? (
                  <input
                    className="prop-edit-input page-prop-input"
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={() => handleUpdatePageProp(prop.key)}
                    onKeyDown={e => {
                      if (e.key === "Enter") handleUpdatePageProp(prop.key);
                      if (e.key === "Escape") setEditingProp(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <span
                    className="prop-value"
                    onClick={() => { setEditingProp(prop.key); setEditValue(prop.value ?? ""); }}
                  >
                    {prop.value || "—"}
                  </span>
                )}
                <span className="prop-delete" onClick={() => handleDeletePageProp(prop.key)}>×</span>
              </div>
            ))}
            {addingProp && (
              <div className="page-prop-row">
                <input
                  className="prop-edit-input"
                  placeholder="key"
                  value={newKey}
                  onChange={e => setNewKey(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Escape") setAddingProp(false);
                  }}
                  autoFocus
                />
                <input
                  className="prop-edit-input page-prop-input"
                  placeholder="value"
                  value={newValue}
                  onChange={e => setNewValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleAddPageProp();
                    if (e.key === "Escape") setAddingProp(false);
                  }}
                />
              </div>
            )}
            {pageProps.length === 0 && !addingProp && (
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                No properties. Click + to add one.
              </div>
            )}
          </div>
        </div>
      )}

      <div className="content">
        <div className="block-list">
          {blocks.length === 0 && (
            <div style={{ color: "var(--text-muted)", padding: "8px 0" }}>
              No blocks yet. Add one below.
            </div>
          )}

          {blocks.map(block => (
            <BlockItem
              key={block.id}
              block={block}
              onUpdate={onUpdateBlock}
              onDelete={onDeleteBlock}
              onPageLinkClick={onPageLinkClick}
            />
          ))}

          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <input
              ref={inputRef}
              className="search-input"
              placeholder="Add a block... (supports [[wiki links]])"
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary" onClick={handleAdd}>Add</button>
          </div>

          <BacklinksPanel pageId={page.id} onPageClick={onPageLinkClick} />
        </div>
      </div>
    </>
  );
}
