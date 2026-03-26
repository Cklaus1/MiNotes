import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { Block, PageTree, Property } from "../lib/api";
import * as api from "../lib/api";
import { getSettings } from "../lib/settings";
import BlockItem from "./BlockItem";
import type { BlockItemHandle } from "./BlockItem";
import BacklinksPanel from "./BacklinksPanel";
import UnlinkedRefsPanel from "./UnlinkedRefsPanel";
import LinkPreview from "./LinkPreview";
import { undoStack } from "../lib/undoStack";
import { registerTestApi } from "../lib/testApi";
interface Props {
  pageTree: PageTree;
  onUpdateBlock: (id: string, content: string) => void;
  onDeleteBlock: (id: string) => void;
  onPageLinkClick: (title: string) => void;
  onShiftClick?: (title: string) => void;
  onJournalNav?: (date: string) => void;
  onRefreshPage: () => void;
  onOpenWhiteboard?: (whiteboardId: string) => void;
  onRenamePage?: (newTitle: string) => void;
}

export default function PageView({
  pageTree, onUpdateBlock, onDeleteBlock, onPageLinkClick, onShiftClick, onJournalNav, onRefreshPage, onOpenWhiteboard, onRenamePage,
}: Props) {
  const { page } = pageTree;
  // Local blocks state for optimistic updates (prevents full re-render on Enter)
  const [localBlocks, setLocalBlocks] = useState(pageTree.blocks);
  const blocks = localBlocks;

  // Sync from props when page changes or blocks update from parent
  useEffect(() => {
    setLocalBlocks(pageTree.blocks);
  }, [pageTree]);
  const [pageProps, setPageProps] = useState<Property[]>([]);
  const [zoomedBlockId, setZoomedBlockId] = useState<string | null>(null);
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
  const [activeBlockId, setActiveBlockIdState] = useState<string | null>(null);
  const activeBlockIdRef = useRef<string | null>(null);
  const activeBlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced active block update — prevents re-render from stealing editor focus on click
  const setActiveBlockId = useCallback((id: string | null) => {
    activeBlockIdRef.current = id;
    if (activeBlockTimer.current) clearTimeout(activeBlockTimer.current);
    activeBlockTimer.current = setTimeout(() => {
      setActiveBlockIdState(id);
    }, 50);
  }, []);
  const [linkPreview, setLinkPreview] = useState<{ pageName: string; x: number; y: number } | null>(null);
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
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

  // Auto-create empty block on empty pages (debounced to avoid race with programmatic block creation)
  useEffect(() => {
    if (blocks.length === 0) {
      const timer = setTimeout(async () => {
        // Re-check — blocks might have been added in the meantime
        if (localBlocks.length === 0) {
          try {
            // For virtual journal pages, ensure the page exists first
            if (page.is_journal) {
              try {
                await api.createPage(page.title);
              } catch {
                // Page already exists — that's fine
              }
            }
            await api.createBlock(page.id, "");
            onRefreshPage();
          } catch {
            // Block creation failed — page might not exist
            // Try creating via journal API which handles this
            if (page.is_journal && page.journal_date) {
              try {
                await api.getJournal(page.journal_date);
                onRefreshPage();
              } catch {}
            }
          }
        }
      }, 300);
      return () => clearTimeout(timer);
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
    if (focusBlockIndex !== null) {
      // Small delay to ensure refs are mounted after render
      const timer = setTimeout(() => {
        if (blockRefs.current[focusBlockIndex]) {
          blockRefs.current[focusBlockIndex]?.focus();
        }
        setFocusBlockIndex(null);
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [focusBlockIndex, blocks]);

  // Link preview on hover (300ms delay) or instant on Ctrl+hover
  useEffect(() => {
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let currentLink: HTMLElement | null = null;

    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const wikiLink = target.closest('.wiki-link') as HTMLElement | null;

      if (wikiLink) {
        if (wikiLink === currentLink) return; // Same link, skip
        currentLink = wikiLink;
        const pageName = wikiLink.getAttribute('data-page-name') || wikiLink.textContent;
        if (!pageName) return;

        if (e.ctrlKey || e.metaKey) {
          // Instant preview on Ctrl+hover
          if (hoverTimer) clearTimeout(hoverTimer);
          setLinkPreview({ pageName, x: e.clientX + 10, y: e.clientY + 10 });
        } else {
          // Delayed preview on plain hover
          if (hoverTimer) clearTimeout(hoverTimer);
          const x = e.clientX + 10, y = e.clientY + 10;
          hoverTimer = setTimeout(() => {
            setLinkPreview({ pageName, x, y });
          }, 300);
        }
      } else {
        currentLink = null;
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        setLinkPreview(null);
      }
    };
    document.addEventListener('mousemove', handler);
    return () => {
      document.removeEventListener('mousemove', handler);
      if (hoverTimer) clearTimeout(hoverTimer);
    };
  }, []);

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

  const formatJournalTitle = (dateStr: string) => {
    try {
      // dateStr is "YYYY-MM-DD" — parse as local date (not UTC)
      const [y, m, d] = dateStr.split("-").map(Number);
      const date = new Date(y, m - 1, d);
      return date.toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
    } catch {
      return dateStr;
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
  const handleEnter = async (blockId: string, contentAfterCursor: string, savedContent?: string) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx === -1) return;

    // Create the new block in backend
    const newBlock = await api.createBlock(page.id, contentAfterCursor);
    undoStack.push({ type: 'create', blockId: newBlock.id, pageId: page.id, newContent: contentAfterCursor, timestamp: Date.now() });

    // Optimistically update local state:
    // - Update current block's content to the saved before-cursor text
    // - Insert new block after it
    setLocalBlocks(prev => {
      const copy = [...prev];
      if (savedContent !== undefined) {
        copy[idx] = { ...copy[idx], content: savedContent };
      }
      copy.splice(idx + 1, 0, newBlock);
      return copy;
    });

    // Focus the new block after React renders it
    setTimeout(() => setFocusBlockIndex(idx + 1), 30);
  };

  const handleBackspaceAtStart = async (blockId: string, content: string) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx <= 0) return; // Can't merge first block
    const block = blocks[idx];
    const prevBlock = blocks[idx - 1];
    const mergedContent = prevBlock.content + (content ? "\n" + content : "");
    undoStack.push({ type: 'delete', blockId, pageId: page.id, deletedBlock: { content: block.content, parentId: block.parent_id, position: block.position }, timestamp: Date.now() });
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

  // UX-012: Smart paste — split multi-line paste into multiple blocks
  const handlePasteMultiline = async (blockId: string, lines: string[]) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx === -1) return;
    for (const line of lines) {
      await api.createBlock(page.id, line);
    }
    onRefreshPage();
    setFocusBlockIndex(idx + lines.length);
  };

  // UX-002: Block indent/outdent
  const handleIndent = async (blockId: string) => {
    const flatIdx = blocks.findIndex(b => b.id === blockId);
    if (flatIdx <= 0) return; // Can't indent first block

    const block = blocks[flatIdx];
    // Find the previous sibling (block with same parent_id, positioned before this one)
    const prevSibling = blocks.slice(0, flatIdx).reverse()
      .find(b => b.parent_id === block.parent_id);

    if (!prevSibling) return; // No sibling above to become parent

    // Move block to be child of previous sibling
    await api.moveBlock(blockId, prevSibling.id, block.position);
    onRefreshPage();
  };

  const handleOutdent = async (blockId: string) => {
    const block = blocks.find(b => b.id === blockId);
    if (!block?.parent_id) return; // Already at root level

    const parent = blocks.find(b => b.id === block.parent_id);
    if (!parent) return;

    // Move block to be sibling of parent (same parent as parent)
    await api.reparentBlock(blockId, parent.parent_id ?? undefined);
    onRefreshPage();
  };

  // UX-015: Block duplicate
  const handleDuplicate = async (blockId: string) => {
    const block = blocks.find(b => b.id === blockId);
    if (!block) return;
    await api.createBlock(page.id, block.content, block.parent_id ?? undefined);
    onRefreshPage();
  };

  // UX-002: Toggle block collapse
  const handleToggleCollapse = async (blockId: string) => {
    const block = blocks.find(b => b.id === blockId);
    if (!block) return;
    // Toggle collapsed state via update — we use the content as-is but toggle collapsed
    // Since updateBlock only updates content, we use reparentBlock-style direct approach
    // Actually the collapsed field isn't exposed via updateBlock. We'll use a direct approach.
    // For now, just use updateBlock which preserves collapsed. We need to add a toggle command.
    // Workaround: use the block's current content to update it (no-op on content) but we can't
    // toggle collapsed this way. Let's just manage it client-side for now.
    // Actually, let's just track collapsed state locally since the backend blocks don't get modified.
    // We'll do this with local state.
  };

  // Track collapsed blocks locally, persisted to localStorage per page
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("minotes-collapsed-" + page.id);
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch {}
    return new Set();
  });

  // Re-read from localStorage when page changes
  useEffect(() => {
    try {
      const stored = localStorage.getItem("minotes-collapsed-" + page.id);
      if (stored) {
        setCollapsedBlocks(new Set(JSON.parse(stored) as string[]));
      } else {
        setCollapsedBlocks(new Set());
      }
    } catch {
      setCollapsedBlocks(new Set());
    }
  }, [page.id]);

  const toggleCollapse = (blockId: string) => {
    setCollapsedBlocks(prev => {
      const next = new Set(prev);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }
      localStorage.setItem("minotes-collapsed-" + page.id, JSON.stringify([...next]));
      return next;
    });
  };

  // Drag-to-reorder blocks
  const handleDragReorder = useCallback(async (draggedBlockId: string, targetBlockId: string, position: "above" | "below") => {
    const target = blocks.find(b => b.id === targetBlockId);
    if (!target) return;

    const siblings = blocks
      .filter(b => (b.parent_id ?? null) === (target.parent_id ?? null))
      .sort((a, b) => a.position - b.position);
    const targetSibIdx = siblings.findIndex(b => b.id === targetBlockId);

    let newPos: number;
    if (position === "above") {
      const prev = targetSibIdx > 0 ? siblings[targetSibIdx - 1].position : 0;
      newPos = (prev + target.position) / 2;
    } else {
      const next = targetSibIdx < siblings.length - 1 ? siblings[targetSibIdx + 1].position : target.position + 1;
      newPos = (target.position + next) / 2;
    }

    // Optimistic update — update position and re-sort
    setLocalBlocks(prev =>
      prev
        .map(b => b.id === draggedBlockId ? { ...b, parent_id: target.parent_id, position: newPos } : b)
        .sort((a, b) => a.position - b.position)
    );

    // Persist — reorderBlock handles null parent_id for root-level blocks
    try {
      await api.reorderBlock(draggedBlockId, target.parent_id ?? undefined, newPos);
    } catch (e) {
      console.error("reorder_block failed:", e);
      onRefreshPage(); // Revert optimistic update on failure
    }
  }, [blocks, onRefreshPage]);

  // Build block tree structure for computing depth and children info
  const blockTreeInfo = useMemo(() => {
    const childrenMap = new Map<string, string[]>();
    const depthMap = new Map<string, number>();

    // Build children map
    for (const block of blocks) {
      const parentKey = block.parent_id ?? "__root__";
      if (!childrenMap.has(parentKey)) childrenMap.set(parentKey, []);
      childrenMap.get(parentKey)!.push(block.id);
    }

    // Compute depths
    const computeDepth = (blockId: string, depth: number) => {
      depthMap.set(blockId, depth);
      const children = childrenMap.get(blockId) ?? [];
      for (const childId of children) {
        computeDepth(childId, depth + 1);
      }
    };
    const roots = childrenMap.get("__root__") ?? [];
    for (const rootId of roots) {
      computeDepth(rootId, 0);
    }

    return {
      getDepth: (id: string) => depthMap.get(id) ?? 0,
      hasChildren: (id: string) => (childrenMap.get(id) ?? []).length > 0,
      isLastSibling: (id: string) => {
        const block = blocks.find(b => b.id === id);
        if (!block) return true;
        const parentKey = block.parent_id ?? "__root__";
        const siblings = childrenMap.get(parentKey) ?? [];
        return siblings[siblings.length - 1] === id;
      },
      getAncestorIds: (id: string): string[] => {
        const ancestors: string[] = [];
        let current = blocks.find(b => b.id === id);
        while (current?.parent_id) {
          ancestors.push(current.parent_id);
          current = blocks.find(b => b.id === current!.parent_id);
        }
        return ancestors;
      },
      isHiddenByCollapse: (id: string) => {
        // Walk up the parent chain; if any ancestor is collapsed, this block is hidden
        let current = blocks.find(b => b.id === id);
        while (current?.parent_id) {
          if (collapsedBlocks.has(current.parent_id)) return true;
          current = blocks.find(b => b.id === current!.parent_id);
        }
        return false;
      },
    };
  }, [blocks]);

  // Ensure blockRefs array is properly sized
  useEffect(() => {
    blockRefs.current = blockRefs.current.slice(0, blocks.length);
    while (blockRefs.current.length < blocks.length) {
      blockRefs.current.push(null);
    }
  }, [blocks.length]);

  // Reset zoom when page changes
  useEffect(() => {
    setZoomedBlockId(null);
  }, [page.id]);

  // UX-005: Handle page link clicks with shift support
  const handlePageLinkClick = useCallback((title: string, shiftKey?: boolean) => {
    if (shiftKey && onShiftClick) {
      onShiftClick(title);
    } else {
      onPageLinkClick(title);
    }
  }, [onPageLinkClick, onShiftClick]);

  // UX-006: Block zoom helpers
  const getDescendants = useCallback((allBlocks: typeof blocks, rootId: string) => {
    const rootBlock = allBlocks.find(b => b.id === rootId);
    if (!rootBlock) return allBlocks;

    const result = [rootBlock];
    const collectChildren = (parentId: string) => {
      const children = allBlocks.filter(b => b.parent_id === parentId);
      for (const child of children) {
        result.push(child);
        collectChildren(child.id);
      }
    };
    collectChildren(rootId);
    return result;
  }, []);

  const getBreadcrumbs = useCallback((allBlocks: typeof blocks, blockId: string) => {
    const crumbs: typeof blocks = [];
    let current = allBlocks.find(b => b.id === blockId);
    while (current) {
      crumbs.unshift(current);
      if (!current.parent_id) break;
      current = allBlocks.find(b => b.id === current!.parent_id);
    }
    return crumbs;
  }, []);

  const visibleBlocks = zoomedBlockId
    ? getDescendants(blocks, zoomedBlockId)
    : blocks;

  // Filter visible blocks (exclude collapsed children + duplicate H1 title)
  const filteredVisibleBlocks = visibleBlocks.filter((b, idx) => {
    if (blockTreeInfo.isHiddenByCollapse(b.id)) return false;
    // Hide first block if it's an H1 matching the page title (redundant with header)
    if (idx === 0 && !b.parent_id) {
      const trimmed = b.content.trim();
      if (trimmed.startsWith("# ") && trimmed.slice(2).trim() === page.title) return false;
    }
    return true;
  });

  // Active path: the focused block + all its ancestors
  const activePathIds = new Set<string>(
    activeBlockId
      ? [activeBlockId, ...blockTreeInfo.getAncestorIds(activeBlockId)]
      : []
  );

  // Register block-level test API
  useEffect(() => {
    registerTestApi({
      typeInBlock: (blockIndex: number, text: string) => {
        const el = document.querySelectorAll('.ProseMirror')[blockIndex];
        if (!el) return false;
        (el as HTMLElement).focus();
        document.execCommand('insertText', false, text);
        return true;
      },
      setBlockContent: (blockIndex: number, markdown: string) => {
        const block = filteredVisibleBlocks[blockIndex];
        if (!block) return false;
        onUpdateBlock(block.id, markdown);
        setLocalBlocks(prev => prev.map(b => b.id === block.id ? { ...b, content: markdown } : b));
        return true;
      },
      getBlockContent: (blockIndex: number) => {
        const block = filteredVisibleBlocks[blockIndex];
        return block?.content ?? null;
      },
      getBlocks: () => filteredVisibleBlocks.map((b, i) => ({ index: i, content: b.content })),
      pressEnterInBlock: (blockIndex: number) => {
        const ref = blockRefs.current[blockIndex];
        if (!ref) return false;
        ref.focus();
        const el = document.querySelectorAll('.ProseMirror')[blockIndex];
        if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      },
      focusBlock: (blockIndex: number) => {
        const ref = blockRefs.current[blockIndex];
        if (ref) { ref.focus(); return true; }
        return false;
      },
      getBlockCount: () => filteredVisibleBlocks.length,
      toggleCheckbox: (blockIndex: number, itemIndex: number = 0) => {
        // Get the block and modify its content to toggle the checkbox
        const block = filteredVisibleBlocks[blockIndex];
        if (!block) return false;
        // Parse the markdown — find the nth [ ] or [x] and toggle it
        let content = block.content;
        let count = 0;
        const toggled = content.replace(/- \[([ x])\]/g, (match, state) => {
          if (count === itemIndex) {
            count++;
            return state === 'x' ? '- [ ]' : '- [x]';
          }
          count++;
          return match;
        });
        if (toggled !== content) {
          onUpdateBlock(block.id, toggled);
          setLocalBlocks(prev => prev.map(b => b.id === block.id ? { ...b, content: toggled } : b));
          return true;
        }
        return false;
      },
    });
  }, [filteredVisibleBlocks]);

  // UX-006: Zoom keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === "ArrowRight") {
        const activeEl = document.activeElement?.closest(".block");
        if (activeEl) {
          const blockId = activeEl.getAttribute("data-block-id");
          if (blockId) {
            e.preventDefault();
            setZoomedBlockId(blockId);
          }
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (zoomedBlockId) {
          const current = blocks.find(b => b.id === zoomedBlockId);
          if (current?.parent_id) {
            setZoomedBlockId(current.parent_id);
          } else {
            setZoomedBlockId(null);
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [zoomedBlockId, blocks]);

  // UX-013: Multi-block selection — shift-click handler
  const handleShiftClick = useCallback((blockId: string) => {
    const clickedIdx = filteredVisibleBlocks.findIndex(b => b.id === blockId);
    if (clickedIdx === -1) return;
    const anchor = selectionAnchor ?? focusBlockIndex ?? 0;
    const start = Math.min(anchor, clickedIdx);
    const end = Math.max(anchor, clickedIdx);
    const ids = new Set(filteredVisibleBlocks.slice(start, end + 1).map(b => b.id));
    setSelectedBlockIds(ids);
    setSelectionAnchor(anchor);
  }, [filteredVisibleBlocks, selectionAnchor, focusBlockIndex]);

  // UX-013: Block ref click handler — navigate to the block's page
  const handleBlockRefClick = useCallback((blockId: string) => {
    // Try to find the block in current page first
    const localBlock = blocks.find(b => b.id === blockId);
    if (localBlock) {
      const idx = filteredVisibleBlocks.findIndex(b => b.id === blockId);
      if (idx !== -1) {
        setFocusBlockIndex(idx);
      }
      return;
    }
    // If not local, try to navigate to the block's page via search
    api.search(blockId, 1).then(results => {
      if (results.length > 0) {
        api.getPageTree(results[0].page_id).then(tree => {
          onPageLinkClick(tree.page.title);
        }).catch(() => {});
      }
    }).catch(() => {});
  }, [blocks, filteredVisibleBlocks, onPageLinkClick]);

  // UX-013: Batch operations on multi-block selection
  const deleteSelected = useCallback(async () => {
    for (const id of selectedBlockIds) {
      await api.deleteBlock(id);
    }
    setSelectedBlockIds(new Set());
    setSelectionAnchor(null);
    onRefreshPage();
  }, [selectedBlockIds, onRefreshPage]);

  const copySelected = useCallback(() => {
    const text = filteredVisibleBlocks
      .filter(b => selectedBlockIds.has(b.id))
      .map(b => b.content)
      .join("\n");
    navigator.clipboard.writeText(text);
  }, [filteredVisibleBlocks, selectedBlockIds]);

  // UX-013: Keyboard handler for batch operations on selection
  useEffect(() => {
    if (selectedBlockIds.size === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        copySelected();
      }
      if (e.key === "Escape") {
        setSelectedBlockIds(new Set());
        setSelectionAnchor(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedBlockIds, deleteSelected, copySelected]);

  // Clear multi-block selection when page changes
  useEffect(() => {
    setSelectedBlockIds(new Set());
    setSelectionAnchor(null);
  }, [page.id]);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(page.title);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const handleTitleSave = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== page.title && onRenamePage) {
      onRenamePage(trimmed);
    }
    setEditingTitle(false);
  };

  return (
    <div className="page-view">
      <div className="main-header">
        {editingTitle && !page.is_journal ? (
          <input
            ref={titleInputRef}
            className="page-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleTitleSave();
              if (e.key === "Escape") { setTitleDraft(page.title); setEditingTitle(false); }
            }}
            autoFocus
          />
        ) : (
          <h2
            className={onRenamePage && !page.is_journal ? "page-title-editable" : ""}
            onClick={() => {
              if (onRenamePage && !page.is_journal) {
                setTitleDraft(page.title);
                setEditingTitle(true);
              }
            }}
            title={onRenamePage && !page.is_journal ? "Click to rename" : undefined}
          >
            {page.icon ?? (page.is_journal ? "\u{1F4C5}" : "")} {page.is_journal && page.journal_date ? formatJournalTitle(page.journal_date) : page.title}
          </h2>
        )}
        {page.is_journal && onJournalNav && (
          <div className="journal-nav">
            <button className="btn btn-sm" onClick={() => shiftDate(-1)}>← Prev</button>
            <button className="btn btn-sm" onClick={() => onJournalNav(new Date().toISOString().slice(0, 10))}>Today</button>
            <button className="btn btn-sm" onClick={() => shiftDate(1)}>Next →</button>
          </div>
        )}
        <button
          className="prop-toggle-btn"
          onClick={() => setShowProps(p => !p)}
          title="Page info"
          style={{ marginLeft: "auto" }}
        >
          ℹ
        </button>
      </div>

      {/* Show existing aliases inline (compact, no add button — use ⚙ properties to add) */}
      {aliases.length > 0 && (
        <div className="page-aliases">
          <span className="page-aliases-label">Aliases:</span>
          {aliases.map(alias => (
            <span key={alias} className="alias-chip">
              {alias}
              <span className="alias-remove" onClick={() => handleRemoveAlias(alias)}>×</span>
            </span>
          ))}
        </div>
      )}

      {showProps && (
        <div className="page-properties">
          <div className="page-info-summary">
            <span className="page-info-date">Updated: {formatDate(page.updated_at)}</span>
          </div>
          <div className="page-properties-header">
            <span className="page-properties-label">Properties</span>
            <button
              className="page-prop-add-btn"
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
          </div>
          {/* Aliases section inside properties panel */}
          <div className="page-properties-header" style={{ marginTop: 8 }}>
            <span className="page-properties-label">Aliases</span>
            <button
              className="page-prop-add-btn"
              onClick={() => setAddingAlias(true)}
              title="Add alias"
            >
              +
            </button>
          </div>
          <div className="page-aliases-inline">
            {aliases.map(alias => (
              <span key={alias} className="alias-chip">
                {alias}
                <span className="alias-remove" onClick={() => handleRemoveAlias(alias)}>×</span>
              </span>
            ))}
            {addingAlias && (
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
            )}
          </div>
        </div>
      )}

      {zoomedBlockId && (
        <div className="breadcrumb-bar">
          <span className="breadcrumb-item" onClick={() => setZoomedBlockId(null)}>
            {page.title}
          </span>
          {getBreadcrumbs(blocks, zoomedBlockId).map(b => (
            <span key={b.id}>
              <span className="breadcrumb-sep"> &rsaquo; </span>
              <span className="breadcrumb-item" onClick={() => setZoomedBlockId(b.id)}>
                {b.content.slice(0, 30) || "(empty)"}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="content view-content markdown-source-view">
        <div className={`block-list ${getSettings().fullTreeMode ? 'tree-mode' : ''}`}>
          {filteredVisibleBlocks.map((block, idx) => (
            <BlockItem
              key={block.id}
              ref={(el) => { blockRefs.current[idx] = el; }}
              block={block}
              depth={blockTreeInfo.getDepth(block.id)}
              dataBlockId={block.id}
              selected={selectedBlockIds.has(block.id)}
              onUpdate={(id, content) => {
                // Update local state so editor picks up the new content
                setLocalBlocks(prev => prev.map(b => b.id === id ? { ...b, content } : b));
                onUpdateBlock(id, content);
              }}
              onDelete={onDeleteBlock}
              onPageLinkClick={handlePageLinkClick}
              onBlockRefClick={handleBlockRefClick}
              onEnter={handleEnter}
              onBackspaceAtStart={handleBackspaceAtStart}
              onArrowUp={handleArrowUp}
              onArrowDown={handleArrowDown}
              onPasteMultiline={handlePasteMultiline}
              onIndent={handleIndent}
              onOutdent={handleOutdent}
              onDuplicate={handleDuplicate}
              onToggleCollapse={toggleCollapse}
              onZoomIn={() => setZoomedBlockId(block.id)}
              hasChildren={blockTreeInfo.hasChildren(block.id)}
              isLastSibling={(() => {
                const next = filteredVisibleBlocks[idx + 1];
                if (!next) return true;
                return (next.parent_id ?? null) !== (block.parent_id ?? null);
              })()}
              isOnActivePath={activePathIds.has(block.id)}
              onFocusBlock={setActiveBlockId}
              onBlurBlock={() => {
                // Only clear if no other block takes focus within 100ms
                // Prevents flash when clicking between blocks
                setTimeout(() => {
                  if (activeBlockIdRef.current === block.id) {
                    setActiveBlockId(null);
                  }
                }, 100);
              }}
              onShiftClick={handleShiftClick}
              onOpenWhiteboard={onOpenWhiteboard}
              onDragReorder={handleDragReorder}
            />
          ))}

          {!zoomedBlockId && (
            <>
              <BacklinksPanel pageId={page.id} onPageClick={onPageLinkClick} />
              <UnlinkedRefsPanel pageId={page.id} pageTitle={page.title} onPageClick={onPageLinkClick} />
            </>
          )}
        </div>
      </div>
      {linkPreview && (
        <LinkPreview
          pageName={linkPreview.pageName}
          x={linkPreview.x}
          y={linkPreview.y}
          onClose={() => setLinkPreview(null)}
          onPageClick={onPageLinkClick}
        />
      )}
    </div>
  );
}
