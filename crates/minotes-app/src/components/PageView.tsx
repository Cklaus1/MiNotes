import { useState, useRef, useCallback, useEffect } from "react";
import type { PageTree, Property } from "../lib/api";
import * as api from "../lib/api";
import BlockItem from "./BlockItem";
import type { BlockItemHandle } from "./BlockItem";
import BacklinksPanel from "./BacklinksPanel";
import UnlinkedRefsPanel from "./UnlinkedRefsPanel";

interface Props {
  pageTree: PageTree;
  onUpdateBlock: (id: string, content: string) => void;
  onDeleteBlock: (id: string) => void;
  onPageLinkClick: (title: string) => void;
  onJournalNav?: (date: string) => void;
  onRefreshPage: () => void;
}

export default function PageView({
  pageTree, onUpdateBlock, onDeleteBlock, onPageLinkClick, onJournalNav, onRefreshPage,
}: Props) {
  const { page, blocks } = pageTree;
  const [pageProps, setPageProps] = useState<Property[]>([]);
  const [showProps, setShowProps] = useState(false);
  const [addingProp, setAddingProp] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingProp, setEditingProp] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [addingAlias, setAddingAlias] = useState(false);
  const [newAlias, setNewAlias] = useState("");
  const [focusBlockIndex, setFocusBlockIndex] = useState<number | null>(null);
  const blockRefs = useRef<Array<BlockItemHandle | null>>([]);

  // Load page properties
  useEffect(() => {
    api.getProperties(page.id).then(props => {
      setPageProps(props);
      if (props.length > 0) setShowProps(true);
    }).catch(() => {});
  }, [page.id]);

  // Load aliases
  useEffect(() => {
    api.getAliases(page.id).then(setAliases).catch(() => {});
  }, [page.id]);

  // Auto-create empty block on empty pages
  useEffect(() => {
    if (blocks.length === 0) {
      api.createBlock(page.id, "").then(() => onRefreshPage());
    }
  }, [page.id, blocks.length]);

  // Auto-focus on page open (UX-004)
  const prevPageIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (page.id !== prevPageIdRef.current) {
      prevPageIdRef.current = page.id;
      if (blocks.length > 0 && focusBlockIndex === null) {
        const targetIdx = page.is_journal ? blocks.length - 1 : 0;
        setFocusBlockIndex(targetIdx);
      }
    }
  }, [page.id, blocks.length]);

  // Execute focus when focusBlockIndex changes
  useEffect(() => {
    if (focusBlockIndex !== null && blockRefs.current[focusBlockIndex]) {
      blockRefs.current[focusBlockIndex]?.focus();
      setFocusBlockIndex(null);
    }
  }, [focusBlockIndex, blocks]);

  const handleAddAlias = async () => {
    const a = newAlias.trim();
    if (!a) return;
    try {
      await api.addAlias(page.id, a);
      setAliases(prev => [...prev, a]);
      setNewAlias("");
      setAddingAlias(false);
    } catch {}
  };

  const handleRemoveAlias = async (alias: string) => {
    try {
      await api.removeAlias(alias);
      setAliases(prev => prev.filter(a => a !== alias));
    } catch {}
  };

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

  // Journal date navigation helpers
  const getJournalDate = () => page.journal_date ?? null;

  const shiftDate = (days: number) => {
    const d = getJournalDate();
    if (!d || !onJournalNav) return;
    const date = new Date(d + "T00:00:00");
    date.setDate(date.getDate() + days);
    onJournalNav(date.toISOString().slice(0, 10));
  };

  // UX-001: Seamless block creation
  const handleEnter = async (blockId: string, contentAfterCursor: string) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx === -1) return;
    const currentBlock = blocks[idx];

    // If there's content after the cursor, update the current block to remove it
    if (contentAfterCursor) {
      const contentBefore = currentBlock.content.slice(
        0,
        currentBlock.content.length - contentAfterCursor.length,
      );
      await api.updateBlock(blockId, contentBefore);
    }

    // Create new block with the split content
    await api.createBlock(page.id, contentAfterCursor);
    onRefreshPage();
    setFocusBlockIndex(idx + 1);
  };

  const handleBackspaceAtStart = async (blockId: string, content: string) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx <= 0) return; // Can't merge first block
    const prevBlock = blocks[idx - 1];
    const mergedContent = prevBlock.content + (content ? "\n" + content : "");
    await api.updateBlock(prevBlock.id, mergedContent);
    await api.deleteBlock(blockId);
    onRefreshPage();
    setFocusBlockIndex(idx - 1);
  };

  const handleArrowUp = (blockId: string) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx > 0) setFocusBlockIndex(idx - 1);
  };

  const handleArrowDown = (blockId: string) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx < blocks.length - 1) setFocusBlockIndex(idx + 1);
  };

  // Ensure blockRefs array is properly sized
  useEffect(() => {
    blockRefs.current = blockRefs.current.slice(0, blocks.length);
    while (blockRefs.current.length < blocks.length) {
      blockRefs.current.push(null);
    }
  }, [blocks.length]);

  return (
    <div className="page-view">
      <div className="main-header">
        <h2>{page.icon ?? (page.is_journal ? "\u{1F4C5}" : "")} {page.title}</h2>
        {page.is_journal && onJournalNav && (
          <div className="journal-nav">
            <button className="btn btn-sm" onClick={() => shiftDate(-1)}>← Prev</button>
            <button className="btn btn-sm" onClick={() => onJournalNav(new Date().toISOString().slice(0, 10))}>Today</button>
            <button className="btn btn-sm" onClick={() => shiftDate(1)}>Next →</button>
          </div>
        )}
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

      {(aliases.length > 0 || addingAlias) && (
        <div className="page-aliases">
          <span className="page-aliases-label">Aliases:</span>
          {aliases.map(alias => (
            <span key={alias} className="alias-chip">
              {alias}
              <span className="alias-remove" onClick={() => handleRemoveAlias(alias)}>×</span>
            </span>
          ))}
          {addingAlias ? (
            <input
              className="alias-input"
              placeholder="alias..."
              value={newAlias}
              onChange={e => setNewAlias(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") handleAddAlias();
                if (e.key === "Escape") { setAddingAlias(false); setNewAlias(""); }
              }}
              onBlur={() => { if (!newAlias.trim()) setAddingAlias(false); }}
              autoFocus
            />
          ) : (
            <button className="alias-add-btn" onClick={() => setAddingAlias(true)} title="Add alias">+</button>
          )}
        </div>
      )}
      {aliases.length === 0 && !addingAlias && (
        <div className="page-aliases">
          <button className="alias-add-btn" onClick={() => setAddingAlias(true)} title="Add alias" style={{ fontSize: 11, opacity: 0.5 }}>+ alias</button>
        </div>
      )}

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

      <div className="content view-content markdown-source-view">
        <div className="block-list">
          {blocks.map((block, idx) => (
            <BlockItem
              key={block.id}
              ref={(el) => { blockRefs.current[idx] = el; }}
              block={block}
              onUpdate={onUpdateBlock}
              onDelete={onDeleteBlock}
              onPageLinkClick={onPageLinkClick}
              onEnter={handleEnter}
              onBackspaceAtStart={handleBackspaceAtStart}
              onArrowUp={handleArrowUp}
              onArrowDown={handleArrowDown}
            />
          ))}

          <BacklinksPanel pageId={page.id} onPageClick={onPageLinkClick} />
          <UnlinkedRefsPanel pageId={page.id} pageTitle={page.title} onPageClick={onPageLinkClick} />
        </div>
      </div>
    </div>
  );
}
