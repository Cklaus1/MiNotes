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
import TableOfContents from "./TableOfContents";
import { downloadHtml, printPage } from "../lib/exportPage";
import { extractTags } from "../lib/tagExtractor";
import { showToast } from "../lib/toast";

// Bug #25: common words excluded from link-suggestion overlap scoring so that
// stopwords (which pass a naive length>=4 filter) don't drive bogus matches.
const LINK_STOPWORDS = new Set<string>([
  "this", "that", "these", "those", "there", "their", "them", "they", "then",
  "with", "from", "your", "yours", "have", "here", "what", "when", "which",
  "while", "about", "would", "could", "should", "into", "than", "been", "were",
  "will", "also", "some", "such", "only", "very", "just", "like", "more", "most",
  "over", "after", "before", "because", "between", "where", "other", "each",
]);

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
  // Bug #19: focus targets a block *id*, not an array index. Indices into the raw
  // `blocks` array and into the rendered `filteredVisibleBlocks` list diverge (hidden
  // H1 title, collapsed subtrees), so an index set by one handler focused the wrong
  // element. A block id is unambiguous across both spaces.
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);

  // AI: Tag suggestions
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [dismissedTags, setDismissedTags] = useState<Set<string>>(new Set());
  useEffect(() => {
    const { tags } = extractTags(blocks);
    // Bug #33: keep dismissed tags dismissed across edits — only filter them out,
    // never reset the dismissed set on every keystroke.
    setSuggestedTags(tags.filter((t) => !dismissedTags.has(t)));
  }, [blocks, dismissedTags]);
  // Reset dismissals only when navigating to a different page.
  useEffect(() => {
    setDismissedTags(new Set());
  }, [page.id]);

  // AI: Link suggestions
  const [suggestedLinks, setSuggestedLinks] = useState<
    Array<{ pageId: string; title: string; score: number; reason: string }>
  >([]);
  const [dismissedLinks, setDismissedLinks] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Simple heuristic: suggest pages whose titles share meaningful words with the
    // current page content. Bug #25: filter stopwords (so "these"/"that"/"with" don't
    // drive matches) and score by overlap ratio clamped to 100%.
    const isMeaningful = (w: string) => w.length >= 4 && !LINK_STOPWORDS.has(w);
    const contentWords = new Set<string>(
      blocks.map((b) => b.content).join(" ").toLowerCase().split(/\s+/).filter(isMeaningful),
    );
    const existingTitles = new Set(dismissedLinks);
    api.listPages(100).then((allPages: api.Page[]) => {
      const scored: Array<{ pageId: string; title: string; score: number }> = [];
      for (const p of allPages) {
        if (p.id === page.id) continue;
        if (existingTitles.has(p.title)) continue;
        const titleWords = p.title.toLowerCase().split(/\s+/).filter(isMeaningful);
        if (titleWords.length === 0) continue;
        const overlap = titleWords.filter((w: string) => contentWords.has(w)).length;
        if (overlap > 0) {
          // Ratio of meaningful title words matched, as a percentage (capped at 100).
          const score = Math.min(100, Math.round((overlap / titleWords.length) * 100));
          scored.push({ pageId: p.id, title: p.title, score });
        }
      }
      setSuggestedLinks(
        scored.sort((a, b) => b.score - a.score).slice(0, 3).map((s) => ({ ...s, reason: `${s.score}% match` })),
      );
    }).catch(() => {});
  }, [blocks, page.id, dismissedLinks]);
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
  // Bug #19: refs keyed by block id (not array index) so focus-by-id is reliable.
  const blockRefs = useRef<Map<string, BlockItemHandle | null>>(new Map());
  const creatingBlockRef = useRef(false);

  
  // Load page properties
  useEffect(() => {
    let cancelled = false;
    api.getProperties(page.id).then(props => {
      if (cancelled) return;
      setPageProps(props);
      if (props.length > 0) setShowProps(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [page.id]);

  // Load aliases
  useEffect(() => {
    let cancelled = false;
    api.getAliases(page.id).then(a => {
      if (cancelled) return;
      setAliases(a);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [page.id]);

  // Auto-create empty block on empty pages (debounced to avoid race with programmatic block creation)
  const localBlocksRef = useRef(localBlocks);
  localBlocksRef.current = localBlocks;
  useEffect(() => {
    if (blocks.length === 0) {
      const timer = setTimeout(async () => {
        // Re-check — blocks might have been added in the meantime
        if (localBlocksRef.current.length === 0 && !creatingBlockRef.current) {
          creatingBlockRef.current = true;
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
          } finally {
            creatingBlockRef.current = false;
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
      if (blocks.length > 0 && focusBlockId === null) {
        const target = page.is_journal ? blocks[blocks.length - 1] : blocks[0];
        if (target) setFocusBlockId(target.id);
      }
    }
  }, [page.id, blocks.length]);

  // Execute focus when focusBlockId changes
  useEffect(() => {
    if (focusBlockId !== null) {
      // Small delay to ensure refs are mounted after render
      const timer = setTimeout(() => {
        blockRefs.current.get(focusBlockId)?.focus();
        setFocusBlockId(null);
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [focusBlockId, blocks]);

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
  // Bug #21: guard against overlapping Enter handling — two awaited createBlock
  // calls racing on the same closure would both splice at idx+1 and duplicate blocks.
  const enterInFlightRef = useRef(false);
  const handleEnter = async (blockId: string, contentAfterCursor: string, savedContent?: string) => {
    if (enterInFlightRef.current) return;
    // Bug #20: read the freshest block state from the ref, not the captured `blocks`
    // closure (which may be stale relative to in-flight optimistic edits).
    const current = localBlocksRef.current;
    const idx = current.findIndex(b => b.id === blockId);
    if (idx === -1) return;
    const currentBlock = current[idx];

    // Bug #18: if the block being split has children, the new block must become its
    // FIRST CHILD so the subtree stays attached. Otherwise it's a sibling at the same
    // indent level. (Standard outliner split behavior.)
    const childPositions = current.filter(b => b.parent_id === blockId).map(b => b.position);
    const hasChildren = childPositions.length > 0;
    const newParentId = hasChildren ? blockId : (currentBlock.parent_id ?? undefined);

    enterInFlightRef.current = true;
    let newBlock: api.Block;
    try {
      newBlock = await api.createBlock(page.id, contentAfterCursor, newParentId);
      if (hasChildren) {
        // Place it before the first existing child.
        const minChildPos = Math.min(...childPositions);
        const firstPos = minChildPos > 0 ? minChildPos / 2 : minChildPos - 1;
        newBlock = await api.moveBlock(newBlock.id, blockId, firstPos);
      }
    } catch (e) {
      console.error("createBlock failed during Enter, restoring text:", e);
      // Glue the after-cursor text back onto the current block content so the
      // user's keystrokes aren't silently dropped.
      const restored = (savedContent ?? currentBlock.content) +
        (contentAfterCursor ? "\n" + contentAfterCursor : "");
      setLocalBlocks(prev => prev.map(b => b.id === blockId ? { ...b, content: restored } : b));
      try {
        await api.updateBlock(blockId, restored);
      } catch {}
      showToast("Could not create new block — your keystrokes were restored. Check connection.");
      enterInFlightRef.current = false;
      return;
    }
    undoStack.push({ type: 'create', blockId: newBlock.id, pageId: page.id, newContent: contentAfterCursor, timestamp: Date.now() });

    // Optimistically update local state:
    // - Update current block's content to the saved before-cursor text
    // - Insert new block after it (immediately after the parent, before any children)
    const createdId = newBlock.id;
    setLocalBlocks(prev => {
      const copy = [...prev];
      const i = copy.findIndex(b => b.id === blockId);
      if (i === -1) return prev;
      if (savedContent !== undefined) {
        copy[i] = { ...copy[i], content: savedContent };
      }
      const newBlockWithParent = { ...newBlock, parent_id: newParentId };
      copy.splice(i + 1, 0, newBlockWithParent);
      return copy;
    });

    // Focus the new block after React renders it (by id — Bug #19).
    setTimeout(() => {
      setFocusBlockId(createdId);
      enterInFlightRef.current = false;
    }, 30);
  };

  const handleBackspaceAtStart = async (blockId: string, content: string) => {
    // Bug #20: use the freshest local block state, not the stale `blocks` closure,
    // so merging into the previous block doesn't overwrite its latest edit.
    const current = localBlocksRef.current;
    const idx = current.findIndex(b => b.id === blockId);
    if (idx <= 0) return; // Can't merge first block
    const block = current[idx];
    const prevBlock = current[idx - 1];
    const mergedContent = prevBlock.content + (content ? "\n" + content : "");
    undoStack.push({ type: 'delete', blockId, pageId: page.id, deletedBlock: { content: block.content, parentId: block.parent_id, position: block.position }, timestamp: Date.now() });
    // Optimistically merge + remove locally so a full page refresh isn't needed
    // (the refresh would discard other in-progress optimistic edits).
    setLocalBlocks(prev => prev
      .map(b => b.id === prevBlock.id ? { ...b, content: mergedContent } : b)
      .filter(b => b.id !== blockId));
    setFocusBlockId(prevBlock.id);
    try {
      await api.updateBlock(prevBlock.id, mergedContent);
      await api.deleteBlock(blockId);
    } catch (e) {
      console.error("Backspace merge failed:", e);
      showToast("Could not merge blocks — check connection.");
      onRefreshPage();
    }
  };

  const handleArrowUp = (blockId: string) => {
    const idx = filteredVisibleBlocks.findIndex(b => b.id === blockId);
    if (idx > 0) setFocusBlockId(filteredVisibleBlocks[idx - 1].id);
  };

  const handleArrowDown = (blockId: string) => {
    const idx = filteredVisibleBlocks.findIndex(b => b.id === blockId);
    if (idx >= 0 && idx < filteredVisibleBlocks.length - 1) setFocusBlockId(filteredVisibleBlocks[idx + 1].id);
  };

  // UX-012: Smart paste — split multi-line paste into multiple blocks
  const handlePasteMultiline = async (blockId: string, lines: string[]) => {
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx === -1) return;
    // Inherit parent_id from the block being pasted into, so pasted lines
    // stay at the same indent level rather than being flattened to root.
    const parentId = blocks[idx].parent_id ?? undefined;
    let lastId: string | null = null;
    for (const line of lines) {
      const created = await api.createBlock(page.id, line, parentId);
      lastId = created.id;
    }
    onRefreshPage();
    if (lastId) setFocusBlockId(lastId);
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
    let needsRenormalize = false;
    if (position === "above") {
      const prev = targetSibIdx > 0 ? siblings[targetSibIdx - 1].position : 0;
      newPos = (prev + target.position) / 2;
      if (target.position - prev < 0.001) needsRenormalize = true;
    } else {
      const next = targetSibIdx < siblings.length - 1 ? siblings[targetSibIdx + 1].position : target.position + 1;
      newPos = (target.position + next) / 2;
      if (next - target.position < 0.001) needsRenormalize = true;
    }

    if (needsRenormalize) {
      // Precision exhausted — renormalize all sibling positions to integers
      const ordered = siblings.filter(b => b.id !== draggedBlockId);
      const insertIdx = position === "above"
        ? ordered.findIndex(b => b.id === targetBlockId)
        : ordered.findIndex(b => b.id === targetBlockId) + 1;
      ordered.splice(insertIdx, 0, { id: draggedBlockId } as (typeof siblings)[0]);
      newPos = insertIdx + 1;
      // Persist renormalized positions for all other siblings
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].id !== draggedBlockId) {
          api.reorderBlock(ordered[i].id, target.parent_id ?? undefined, i + 1).catch(() => {});
        }
      }
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
    const parentMap = new Map<string, string | null>();

    // Build children map and parent map
    for (const block of blocks) {
      const parentKey = block.parent_id ?? "__root__";
      if (!childrenMap.has(parentKey)) childrenMap.set(parentKey, []);
      childrenMap.get(parentKey)!.push(block.id);
      parentMap.set(block.id, block.parent_id ?? null);
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
        const pid = parentMap.get(id);
        const parentKey = pid ?? "__root__";
        const siblings = childrenMap.get(parentKey) ?? [];
        return siblings[siblings.length - 1] === id;
      },
      getAncestorIds: (id: string): string[] => {
        const ancestors: string[] = [];
        let pid = parentMap.get(id) ?? null;
        while (pid) {
          ancestors.push(pid);
          pid = parentMap.get(pid) ?? null;
        }
        return ancestors;
      },
      isHiddenByCollapse: (id: string) => {
        // Walk up the parent chain; if any ancestor is collapsed, this block is hidden
        let pid = parentMap.get(id) ?? null;
        while (pid) {
          if (collapsedBlocks.has(pid)) return true;
          pid = parentMap.get(pid) ?? null;
        }
        return false;
      },
    };
  }, [blocks]);

  // Prune refs for blocks that no longer exist (the ref callback adds new ones).
  useEffect(() => {
    const ids = new Set(blocks.map(b => b.id));
    for (const key of Array.from(blockRefs.current.keys())) {
      if (!ids.has(key)) blockRefs.current.delete(key);
    }
  }, [blocks]);

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

  // Active path: set via DOM to avoid re-rendering blocks (which steals focus in WebKitGTK)
  useEffect(() => {
    document.querySelectorAll('[data-active-path="true"]').forEach(el => el.removeAttribute('data-active-path'));
    if (activeBlockId) {
      const ids = [activeBlockId, ...blockTreeInfo.getAncestorIds(activeBlockId)];
      ids.forEach(id => {
        const el = document.querySelector(`[data-block-id="${id}"]`);
        if (el) el.setAttribute('data-active-path', 'true');
      });
    }
  }, [activeBlockId, blockTreeInfo]);

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
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
        if (!ref) return false;
        ref.focus();
        const el = document.querySelectorAll('.ProseMirror')[blockIndex];
        if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      },
      focusBlock: (blockIndex: number) => {
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
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
    const anchor = selectionAnchor ?? clickedIdx;
    const start = Math.min(anchor, clickedIdx);
    const end = Math.max(anchor, clickedIdx);
    const ids = new Set(filteredVisibleBlocks.slice(start, end + 1).map(b => b.id));
    setSelectedBlockIds(ids);
    setSelectionAnchor(anchor);
  }, [filteredVisibleBlocks, selectionAnchor]);

  // UX-013: Block ref click handler — navigate to the block's page
  const handleBlockRefClick = useCallback((blockId: string) => {
    // Try to find the block in current page first
    const localBlock = blocks.find(b => b.id === blockId);
    if (localBlock) {
      setFocusBlockId(blockId);
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

  const copyPageToClipboard = useCallback(() => {
    const text = filteredVisibleBlocks
      .map(b => b.content)
      .join("\n");
    navigator.clipboard.writeText(text);
  }, [filteredVisibleBlocks]);

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

  // Global keyboard shortcuts: Cmd/Ctrl+A to select all, Cmd/Ctrl+C to copy page
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isSelectAll = (e.ctrlKey || e.metaKey) && e.key === "a";
      const isCopyPage = (e.ctrlKey || e.metaKey) && e.key === "c" && e.shiftKey;
      if (!isSelectAll && !isCopyPage) return;
      // Only intercept when focus is not in an input/textarea
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable ||
          target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      if (isSelectAll) {
        const allIds = new Set(filteredVisibleBlocks.map(b => b.id));
        setSelectedBlockIds(allIds);
      } else if (isCopyPage) {
        copyPageToClipboard();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filteredVisibleBlocks, copyPageToClipboard]);

  // Clear multi-block selection when page changes
  useEffect(() => {
    setSelectedBlockIds(new Set());
    setSelectionAnchor(null);
  }, [page.id]);

  const [editingTitle, setEditingTitle] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const hasHeadings = blocks.some(b => /^#{1,4}\s+/.test(b.content));
  const [titleDraft, setTitleDraft] = useState(page.title);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Save indicator
  const [saveIndicator, setSaveIndicator] = useState<{visible: boolean, time: number} | null>(null);
  const saveIndicatorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSave = useCallback(() => {
    if (saveIndicatorTimeoutRef.current) clearTimeout(saveIndicatorTimeoutRef.current);
    setSaveIndicator({ visible: true, time: Date.now() });
    saveIndicatorTimeoutRef.current = setTimeout(() => setSaveIndicator(null), 1500);
  }, []);

  const handleTitleSave = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== page.title && onRenamePage) {
      onRenamePage(trimmed);
    }
    setEditingTitle(false);
  };

  return (
    <div className="page-view-wrapper">
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
        {hasHeadings && (
          <button
            className="prop-toggle-btn"
            onClick={() => setShowToc(t => !t)}
            title="Table of contents"
            style={{ marginLeft: "auto" }}
          >
            ≡
          </button>
        )}
        {!hasHeadings && <span style={{ marginLeft: "auto" }} />}
        {saveIndicator?.visible && (
          <span className="save-indicator" style={{
            fontSize: 12,
            color: '#22c55e',
            marginLeft: 8,
            animation: 'fadeInOut 1.5s ease-in-out',
          }}>
            ✓ Saved
          </span>
        )}
        <button
          className="prop-toggle-btn"
          onClick={() => setShowProps(p => !p)}
          title="Page info"
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
            <button
              className="page-copy-btn"
              onClick={() => copyPageToClipboard()}
              title="Copy page to clipboard"
            >
              ⎘ Copy
            </button>
            <button
              className="page-export-btn"
              onClick={() => downloadHtml(pageTree)}
              title="Export as HTML"
            >
              ↗ Export
            </button>
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

      {/* AI: Suggested Tags */}
      {suggestedTags.length > 0 && (
        <div className="ai-panel">
          <div className="ai-panel-header">
            <h4>AI Suggested Tags</h4>
            <button className="ai-close" onClick={() => setSuggestedTags([])} title="Dismiss">x</button>
          </div>
          <div className="ai-tag-list">
            {suggestedTags
              .filter((t) => !dismissedTags.has(t))
              .map((tag) => (
                <span key={tag} className="ai-tag-chip">
                  #{tag}
                  <span className="ai-tag-accept" onClick={() => {
                    // Add as page property
                    const existing = pageProps.find((p) => p.key === "tags");
                    const currentTags = existing?.value ? existing.value.split(",").map((s) => s.trim()).filter(Boolean) : [];
                    const newTags = [...new Set([...currentTags, tag])].join(",");
                    api.setProperty(page.id, "page", "tags", newTags);
                    setPageProps((prev) => {
                      const filtered = prev.filter((p) => p.key !== "tags");
                      return [...filtered, { id: "", entity_type: "page", key: "tags", value: newTags, entity_id: page.id, value_type: "string", created_at: "", updated_at: "" }];
                    });
                    setDismissedTags((prev) => new Set([...prev, tag]));
                  }}>+</span>
                  <span className="ai-tag-dismiss" onClick={() => setDismissedTags((prev) => new Set([...prev, tag]))}>x</span>
                </span>
              ))}
          </div>
        </div>
      )}

      {/* AI: Suggested Links */}
      {suggestedLinks.length > 0 && (
        <div className="ai-panel">
          <div className="ai-panel-header">
            <h4>AI Suggested Links</h4>
            <button className="ai-close" onClick={() => setSuggestedLinks([])} title="Dismiss">x</button>
          </div>
          <div className="ai-link-list">
            {suggestedLinks.map((s) => (
              <span key={s.pageId} className="ai-link-chip">
                [[{s.title}]]
                <span className="ai-link-insert" title="Insert link" onClick={async () => {
                  // Bug #28: "+" should INSERT the wiki-link into this page, not
                  // navigate away. Append a block containing the link, then dismiss.
                  try {
                    await api.createBlock(page.id, `[[${s.title}]]`);
                    onRefreshPage();
                  } catch {
                    showToast("Failed to insert link");
                  }
                  setDismissedLinks((prev) => new Set([...prev, s.title]));
                }}>+</span>
                <span className="ai-link-dismiss" onClick={() => setDismissedLinks((prev) => new Set([...prev, s.title]))}>x</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="content view-content markdown-source-view">
        <div className={`block-list ${getSettings().fullTreeMode ? 'tree-mode' : ''}`}>
          {filteredVisibleBlocks.map((block, idx) => (
            <BlockItem
              key={block.id}
              ref={(el) => { if (el) blockRefs.current.set(block.id, el); else blockRefs.current.delete(block.id); }}
              block={block}
              depth={blockTreeInfo.getDepth(block.id)}
              dataBlockId={block.id}
              selected={selectedBlockIds.has(block.id)}
              onUpdate={(id, content) => {
                // Update local state so editor picks up the new content
                setLocalBlocks(prev => prev.map(b => b.id === id ? { ...b, content } : b));
                onUpdateBlock(id, content);
                flashSave();
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
              isOnActivePath={false}
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
    <TableOfContents blocks={blocks} visible={showToc} onClose={() => setShowToc(false)} />
    </div>
  );
}
