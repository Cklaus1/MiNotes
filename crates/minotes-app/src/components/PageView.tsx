import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import type { Block, PageTree, Property } from "../lib/api";
import * as api from "../lib/api";
import { setPendingReveal, takePendingReveal } from "../lib/pendingReveal";
import { getSettings } from "../lib/settings";
import { localDateKey } from "../lib/dates";
import BlockItem from "./BlockItem";
import type { BlockItemHandle, FocusPosition } from "./BlockItem";
import BacklinksPanel from "./BacklinksPanel";
import UnlinkedRefsPanel from "./UnlinkedRefsPanel";
import LinkPreview from "./LinkPreview";
import { undoStack } from "../lib/undoStack";
import { executeRedo } from "../lib/undoManager";
import { registerTestApi } from "../lib/testApi";
import TableOfContents from "./TableOfContents";
import { downloadHtml, printPage } from "../lib/exportPage";
import { extractTags } from "../lib/tagExtractor";
import { showToast } from "../lib/toast";
import { suggestLinks, type LinkSuggestion } from "../lib/linkSuggestions";
import { prefetchBlockProperties } from "../lib/blockProperties";
import { registerFlush } from "../lib/pendingEdits";
import { getSettingsCached } from "../lib/cachedSettings";

/**
 * Big pages render progressively: the first INITIAL_RENDER blocks at once, the
 * rest in slices sized to take ~SLICE_BUDGET_MS each, so the page paints and
 * reacts to input right away instead of freezing until every block exists.
 */
const INITIAL_RENDER = 80;
const SLICE_BUDGET_MS = 40;

/**
 * Blocks created by Enter exist locally (with a temporary id) before the backend
 * has created them, so the new block can take focus within the same keystroke.
 */
let tempIdCounter = 0;
const TEMP_PREFIX = "tmp-";
const newTempId = () => `${TEMP_PREFIX}${Date.now().toString(36)}-${++tempIdCounter}`;
const isTempId = (id: string) => id.startsWith(TEMP_PREFIX);

/** Depth-first outline order (siblings by position) — the order the list renders in. */
function outlineOrder(list: Block[]): Block[] {
  const ids = new Set(list.map(b => b.id));
  const kids = new Map<string, Block[]>();
  for (const b of list) {
    const key = b.parent_id && ids.has(b.parent_id) ? b.parent_id : "__root__";
    const arr = kids.get(key) ?? [];
    arr.push(b);
    kids.set(key, arr);
  }
  const out: Block[] = [];
  const seen = new Set<string>();
  const walk = (key: string) => {
    for (const b of (kids.get(key) ?? []).slice().sort((x, y) => x.position - y.position)) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
      walk(b.id);
    }
  };
  walk("__root__");
  // Anything unreachable (cycles) keeps its place at the end rather than vanishing.
  for (const b of list) if (!seen.has(b.id)) out.push(b);
  return out;
}

const propError = (e: unknown) => String((e as any)?.message ?? e);

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

  // Progressive rendering (see INITIAL_RENDER): how many visible blocks exist in
  // the DOM. Resets to INITIAL_RENDER on every page change.
  const [renderState, setRenderState] = useState({ pageId: pageTree.page.id, limit: INITIAL_RENDER });
  const renderLimit = renderState.pageId === pageTree.page.id ? renderState.limit : INITIAL_RENDER;
  const renderLimitRef = useRef(renderLimit);
  renderLimitRef.current = renderLimit;
  const sliceRef = useRef({ size: 150, startedAt: 0 });

  // Optimistic edits not yet confirmed by a fetched tree. A refresh (e.g. the delayed
  // [[link]] refresh, or a sync import) may carry a tree read BEFORE these edits
  // landed; reconciling against these maps keeps it from clobbering them.
  const pendingEditsRef = useRef<Map<string, { content: string; at: number }>>(new Map());
  const pendingCreatesRef = useRef<Map<string, number>>(new Map());
  const pendingDeletesRef = useRef<Map<string, number>>(new Map());
  const PENDING_TTL_MS = 5000;
  const markEdited = (id: string, content: string) => {
    pendingEditsRef.current.set(id, { content, at: Date.now() });
  };
  const reconciledPageIdRef = useRef(pageTree.page.id);

  // Temporary (optimistic) block id -> real id, and real id -> the temp id it was
  // rendered under (the React key stays the temp id so the editor isn't remounted
  // and doesn't lose focus or keystrokes when the real id arrives).
  const idMapRef = useRef<Map<string, string>>(new Map());
  const renderKeyRef = useRef<Map<string, string>>(new Map());
  const rid = (id: string) => idMapRef.current.get(id) ?? id;
  // Structural backend writes run strictly in order, so a write that names a block
  // created by an earlier Enter runs after that create and can resolve its real id.
  const opQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const p = opQueueRef.current.then(fn, fn);
    opQueueRef.current = p.catch(() => {});
    return p;
  };
  // Save barrier (notebook switch): queued creates/moves must reach THIS notebook.
  useEffect(() => registerFlush(() => opQueueRef.current), []);
  // Undo/redo rewrote these blocks on the backend: drop their optimistic
  // bookkeeping so the refreshed tree (e.g. a restored, recently merged-away
  // block) isn't masked for PENDING_TTL_MS.
  useEffect(() => {
    const handler = (e: Event) => {
      for (const id of (e as CustomEvent<{ ids: string[] }>).detail?.ids ?? []) {
        pendingEditsRef.current.delete(id);
        pendingDeletesRef.current.delete(id);
        pendingCreatesRef.current.delete(id);
      }
    };
    window.addEventListener("minotes-undo-applied", handler);
    return () => window.removeEventListener("minotes-undo-applied", handler);
  }, []);

  // Sync from props when page changes or blocks update from parent.
  // Same page: reconcile by id instead of wholesale replacement.
  useEffect(() => {
    if (reconciledPageIdRef.current !== pageTree.page.id) {
      reconciledPageIdRef.current = pageTree.page.id;
      pendingEditsRef.current.clear();
      pendingCreatesRef.current.clear();
      pendingDeletesRef.current.clear();
      setLocalBlocks(pageTree.blocks);
      return;
    }
    const now = Date.now();
    const fresh = (at: number) => now - at < PENDING_TTL_MS;
    setLocalBlocks(prev => {
      const prevById = new Map(prev.map(b => [b.id, b]));
      const activeId = activeBlockIdRef.current;
      const incomingIds = new Set(pageTree.blocks.map(b => b.id));
      const merged: Block[] = [];
      for (const inc of pageTree.blocks) {
        const delAt = pendingDeletesRef.current.get(inc.id);
        if (delAt !== undefined && fresh(delAt)) continue; // deleted locally; stale tree
        pendingDeletesRef.current.delete(inc.id);
        const local = prevById.get(inc.id);
        let content = inc.content;
        const pending = pendingEditsRef.current.get(inc.id);
        if (pending) {
          if (pending.content === inc.content || !fresh(pending.at)) {
            pendingEditsRef.current.delete(inc.id); // confirmed (or expired)
          } else {
            content = pending.content;
          }
        }
        // The focused editor holds unsaved typing: don't push content under it.
        if (local && inc.id === activeId && content !== local.content &&
            blockRefs.current.get(inc.id)?.isDirty()) {
          content = local.content;
        }
        merged.push(local && local.content === content && local.parent_id === inc.parent_id &&
          local.position === inc.position && local.collapsed === inc.collapsed
          ? local : { ...inc, content });
      }
      // Blocks we just created that this (possibly stale) tree doesn't know yet.
      prev.forEach((b, i) => {
        if (incomingIds.has(b.id)) { pendingCreatesRef.current.delete(b.id); return; }
        const createdAt = pendingCreatesRef.current.get(b.id);
        if (createdAt === undefined || !fresh(createdAt)) return;
        const before = prev.slice(0, i).reverse().find(p => merged.some(m => m.id === p.id));
        const at = before ? merged.findIndex(m => m.id === before.id) + 1 : 0;
        merged.splice(at, 0, b);
      });
      return merged;
    });
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

  // AI feature toggles (Settings → AI). Re-read whenever settings change.
  const [aiSettings, setAiSettings] = useState(() => getSettings().ai);
  useEffect(() => {
    const handler = () => setAiSettings(getSettings().ai);
    window.addEventListener("minotes-settings-changed", handler);
    return () => window.removeEventListener("minotes-settings-changed", handler);
  }, []);
  const autoTagEnabled = aiSettings?.autoTag !== false;
  const linkSuggestionsEnabled = aiSettings?.linkSuggestions !== false;

  // AI: Tag suggestions
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [dismissedTags, setDismissedTags] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!autoTagEnabled) { setSuggestedTags([]); return; }
    const { tags } = extractTags(blocks);
    // Bug #33: keep dismissed tags dismissed across edits — only filter them out,
    // never reset the dismissed set on every keystroke.
    setSuggestedTags(tags.filter((t) => !dismissedTags.has(t)));
  }, [blocks, dismissedTags, autoTagEnabled]);
  // Reset dismissals only when navigating to a different page.
  useEffect(() => {
    setDismissedTags(new Set());
  }, [page.id]);

  // AI: Link suggestions
  const [suggestedLinks, setSuggestedLinks] = useState<LinkSuggestion[]>([]);
  const [dismissedLinks, setDismissedLinks] = useState<Set<string>>(new Set());
  // Only the page's text matters here — keyed on a content string (not the blocks
  // array identity, which changes on every optimistic edit) and debounced.
  const pageText = useMemo(() => blocks.map((b) => b.content).join(" "), [blocks]);
  // Clear stale suggestions immediately on navigation / when disabled, and forget
  // the previous page's dismissals so they don't hide this page's suggestions.
  useEffect(() => { setSuggestedLinks([]); }, [page.id, linkSuggestionsEnabled]);
  useEffect(() => { setDismissedLinks(prev => (prev.size ? new Set() : prev)); }, [page.id]);
  useEffect(() => {
    if (!linkSuggestionsEnabled) return;
    // Relevance rules live in lib/linkSuggestions.ts: a page is suggested only when
    // its title is mentioned here or it shares distinctive keywords — never just
    // because it exists.
    let cancelled = false;
    const timer = setTimeout(() => api.listPages(100).then((allPages: api.Page[]) => {
      if (cancelled) return;
      setSuggestedLinks(suggestLinks(pageText, page.id, allPages, dismissedLinks));
    }).catch(() => {}), 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pageText, page.id, dismissedLinks, linkSuggestionsEnabled]);
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

  
  // Every block's properties in one call, before the blocks' own effects ask
  // (layout effects run before passive ones): see lib/blockProperties.ts.
  useLayoutEffect(() => {
    prefetchBlockProperties(pageTree.blocks.map(b => b.id));
  }, [page.id]);

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

  // Auto-focus on page open (UX-004). A brand-new page has no blocks yet (its first
  // block is created a moment later): focus that block as soon as it appears.
  const prevPageIdRef = useRef<string | null>(null);
  const awaitingFirstBlockRef = useRef<string | null>(null);
  useEffect(() => {
    const nothingFocused = () => {
      const a = document.activeElement;
      return !a || a === document.body || a === document.documentElement;
    };
    if (page.id !== prevPageIdRef.current) {
      prevPageIdRef.current = page.id;
      awaitingFirstBlockRef.current = null;
      // On the render where the page changes, localBlocks still hold the PREVIOUS
      // page's blocks (they're swapped in by the sync effect): use the new tree.
      const fresh = pageTree.blocks;
      const revealId = takePendingReveal(fresh.map(b => b.id));
      if (revealId) {
        setTimeout(() => revealBlockRef.current(revealId), 30);
        return;
      }
      // The first block is hidden when it's an H1 repeating the page title (see
      // filteredVisibleBlocks): focus the first block that is actually rendered.
      const hiddenTitle = (b: Block | undefined) => !!b && !b.parent_id &&
        b.content.trim().startsWith("# ") && b.content.trim().slice(2).trim() === page.title;
      const shown = hiddenTitle(fresh[0]) ? fresh.slice(1) : fresh;
      if (shown.length > 0 && focusBlockId === null) {
        const target = page.is_journal ? shown[shown.length - 1] : shown[0];
        if (target) setFocusBlockId(target.id);
      } else if (fresh.length === 0) {
        awaitingFirstBlockRef.current = page.id;
      }
    } else if (awaitingFirstBlockRef.current === page.id && blocks.length > 0) {
      awaitingFirstBlockRef.current = null;
      // Don't steal focus from something the user moved to meanwhile.
      if (nothingFocused()) setFocusBlockId(blocks[0].id);
    }
  }, [page.id, blocks.length]);

  // Execute focus when focusBlockId changes (optionally at a remembered caret).
  const focusCaretRef = useRef<{ id: string; pos: FocusPosition } | null>(null);
  useEffect(() => {
    if (focusBlockId !== null) {
      // Not rendered yet (progressive rendering of a big page): render everything first.
      if (!blockRefs.current.has(rid(focusBlockId)) && ensureRendered(focusBlockId)) return;
      // Small delay to ensure refs are mounted after render
      const timer = setTimeout(() => {
        const caret = focusCaretRef.current?.id === focusBlockId ? focusCaretRef.current.pos : "end";
        focusCaretRef.current = null;
        blockRefs.current.get(rid(focusBlockId))?.focus(caret);
        setFocusBlockId(null);
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [focusBlockId, blocks, renderLimit]);
  const focusBlockAt = (id: string, pos: FocusPosition) => {
    focusCaretRef.current = { id, pos };
    setFocusBlockId(id);
  };

  // The block whose editor last had focus (its ProseMirror state keeps the caret).
  const lastEditorBlockIdRef = useRef<string | null>(null);
  // Escape that closed an overlay holding focus (search palette, a panel...) drops
  // focus to <body>: put it back in the editor, at the caret it had.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (!t || t === document.body || t.closest?.(".ProseMirror")) return;
      setTimeout(() => {
        if (document.contains(t)) return; // the focused thing wasn't closed
        const a = document.activeElement;
        if (a && a !== document.body && a !== document.documentElement) return;
        const id = lastEditorBlockIdRef.current;
        if (id && localBlocksRef.current.some(b => b.id === id)) blockRefs.current.get(id)?.focus("keep");
      }, 60);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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
    try {
      await api.setProperty(page.id, "page", k, v);
    } catch (e) {
      // Refused by the backend (invalid key/value): say why, add nothing.
      showToast(`Property not saved: ${propError(e)}`);
      return;
    }
    const props = await api.getProperties(page.id).catch(() => null);
    if (props) setPageProps(props);
    setNewKey("");
    setNewValue("");
    setAddingProp(false);
  };

  const savingPropRef = useRef<string | null>(null);
  const handleUpdatePageProp = async (key: string) => {
    // Enter saves and closes the input; the blur that may follow must not save again.
    if (savingPropRef.current === key) return;
    savingPropRef.current = key;
    setTimeout(() => { savingPropRef.current = null; }, 0);
    setEditingProp(null);
    try {
      await api.setProperty(page.id, "page", key, editValue.trim());
    } catch (e) {
      // Refused: the row keeps its old value.
      showToast(`Property not saved: ${propError(e)}`);
      return;
    }
    const props = await api.getProperties(page.id).catch(() => null);
    if (props) setPageProps(props);
  };

  const handleDeletePageProp = async (key: string) => {
    try {
      await api.deleteProperty(page.id, key);
      setPageProps(prev => prev.filter(p => p.key !== key));
    } catch (e) {
      showToast(`Property not deleted: ${propError(e)}`);
    }
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
    // Parsed as local midnight, so it must be formatted as local too —
    // toISOString() here shifted the day for anyone west of UTC.
    onJournalNav(localDateKey(date));
  };

  /**
   * `count` increasing positions strictly between `block` and its next sibling, or
   * null when it has no next sibling (the backend's default append-to-parent-end
   * already lands after it).
   */
  const positionsAfter = (all: Block[], block: Block, count: number): number[] | null => {
    const parent = block.parent_id ?? null;
    const next = all
      .filter(b => (b.parent_id ?? null) === parent && b.id !== block.id && b.position > block.position)
      .sort((a, b) => a.position - b.position)[0];
    if (!next) return null;
    const step = (next.position - block.position) / (count + 1);
    return Array.from({ length: count }, (_, i) => block.position + step * (i + 1));
  };

  // A content save from a block editor. Local state first; a block whose create is
  // still in flight saves once it exists (in order, through the op queue).
  const handleBlockUpdate = (id: string, content: string) => {
    markEdited(id, content);
    setLocalBlocks(prev => prev.map(b => b.id === id ? { ...b, content } : b));
    if (isTempId(id) && !idMapRef.current.has(id)) {
      enqueue(async () => { await onUpdateBlockRef.current(rid(id), content); });
    } else {
      onUpdateBlock(rid(id), content);
    }
    flashSave();
  };
  const onUpdateBlockRef = useRef(onUpdateBlock);
  onUpdateBlockRef.current = onUpdateBlock;

  // UX-001: Seamless block creation — optimistic. The new block is inserted locally
  // and focused synchronously, inside the Enter keystroke, so whatever is typed next
  // lands in it at any typing speed; the backend create runs in the op queue and
  // its real id replaces the temporary one when it returns.
  const canEnter = useCallback(() => true, []);
  const handleEnter = (blockId: string, contentAfterCursor: string, savedContent?: string) => {
    if (savedContent !== undefined) markEdited(blockId, savedContent);
    const current = localBlocksRef.current;
    const idx = current.findIndex(b => b.id === blockId);
    if (idx === -1) return;
    const currentBlock = current[idx];

    // Bug #18: if the block being split has (visible) children, the new block becomes
    // its FIRST CHILD so the subtree stays attached. Otherwise it's a sibling at the
    // same indent level, after the block's whole subtree. (Standard outliner split.)
    const childPositions = current.filter(b => b.parent_id === blockId).map(b => b.position);
    const asChild = childPositions.length > 0 && !collapsedBlocksRef.current.has(blockId);
    const parentId = asChild ? blockId : (currentBlock.parent_id ?? undefined);
    let position: number;
    if (asChild) {
      const minChildPos = Math.min(...childPositions);
      position = minChildPos > 0 ? minChildPos / 2 : minChildPos - 1;
    } else {
      position = positionsAfter(current, currentBlock, 1)?.[0] ?? currentBlock.position + 1;
    }

    const tempId = newTempId();
    const now = new Date().toISOString();
    const temp: Block = {
      id: tempId, page_id: page.id, parent_id: parentId, position, content: contentAfterCursor,
      format: currentBlock.format, collapsed: false, created_at: now, updated_at: now,
    };
    pendingCreatesRef.current.set(tempId, Date.now());
    flushSync(() => {
      setLocalBlocks(prev => {
        const i = prev.findIndex(b => b.id === blockId);
        if (i === -1) return prev;
        const copy = [...prev];
        if (savedContent !== undefined) copy[i] = { ...copy[i], content: savedContent };
        let at = i + 1;
        if (!asChild) {
          // Skip the current block's subtree (outline order: descendants follow it).
          const inSubtree = new Set([blockId]);
          while (at < copy.length && copy[at].parent_id && inSubtree.has(copy[at].parent_id!)) {
            inSubtree.add(copy[at].id);
            at++;
          }
        }
        copy.splice(at, 0, temp);
        return copy;
      });
      // Progressive rendering: one more block, one more rendered (the new block
      // must exist now to take focus, even at the edge of the rendered range).
      setRenderState(st => ({ pageId: page.id, limit: (st.pageId === page.id ? st.limit : INITIAL_RENDER) + 1 }));
    });
    // Same keystroke: the next key event already goes to the new block.
    blockRefs.current.get(tempId)?.focus("start");

    enqueue(async () => {
      const realParent = parentId ? rid(parentId) : undefined;
      let created: api.Block;
      try {
        created = await api.createBlock(page.id, contentAfterCursor, realParent);
        created = asChild
          ? await api.moveBlock(created.id, realParent!, position)
          : await api.reorderBlock(created.id, realParent, position);
      } catch (e) {
        console.error("createBlock failed during Enter, restoring text:", e);
        // Glue whatever the new block holds now back onto the split block so the
        // user's keystrokes aren't silently dropped.
        const typed = blockRefs.current.get(tempId)?.getMarkdown() ?? contentAfterCursor;
        const base = blockRefs.current.get(blockId)?.getMarkdown() ?? savedContent ?? currentBlock.content;
        const restored = base + (typed ? "\n" + typed : "");
        pendingCreatesRef.current.delete(tempId);
        markEdited(blockId, restored);
        setLocalBlocks(prev => prev.filter(b => b.id !== tempId).map(b => b.id === blockId ? { ...b, content: restored } : b));
        try { await api.updateBlock(rid(blockId), restored); } catch {}
        showToast("Could not create new block — your keystrokes were restored. Check connection.");
        return;
      }
      resolveTempId(tempId, created.id);
      undoStack.push({ type: 'create', blockId: created.id, pageId: page.id, newContent: contentAfterCursor, timestamp: Date.now() });
    });
  };

  /** The backend created `tempId` as `realId`: swap ids everywhere, keep local state. */
  const resolveTempId = (tempId: string, realId: string) => {
    idMapRef.current.set(tempId, realId);
    renderKeyRef.current.set(realId, tempId);
    pendingCreatesRef.current.delete(tempId);
    pendingCreatesRef.current.set(realId, Date.now());
    const pe = pendingEditsRef.current.get(tempId);
    if (pe) { pendingEditsRef.current.delete(tempId); pendingEditsRef.current.set(realId, pe); }
    if (activeBlockIdRef.current === tempId) activeBlockIdRef.current = realId;
    if (lastEditorBlockIdRef.current === tempId) lastEditorBlockIdRef.current = realId;
    setLocalBlocks(prev => prev
      // A refresh that raced the create may already carry the real block: the
      // local (temp) copy holds the user's latest typing and wins.
      .filter(b => b.id !== realId || !prev.some(p => p.id === tempId))
      .map(b => {
        if (b.id === tempId) return { ...b, id: realId };
        if (b.parent_id === tempId) return { ...b, parent_id: realId };
        return b;
      }));
  };

  const handleBackspaceAtStart = async (blockId: string, content: string) => {
    // Bug #20: use the freshest local block state, not the stale `blocks` closure,
    // so merging into the previous block doesn't overwrite its latest edit.
    const current = localBlocksRef.current;
    const idx = current.findIndex(b => b.id === blockId);
    if (idx <= 0) return; // Can't merge first block
    const prevBlock = current[idx - 1];
    const merged = current[idx];
    // Capture now: block objects can be shared with the backend layer (the mock
    // returns its stored objects) and get mutated by the updateBlock below.
    const prevOldContent = prevBlock.content;
    const mergedContent = prevOldContent + (content ? "\n" + content : "");
    // deleteBlock cascades, so the merged block's children must be re-homed onto
    // the absorbing block first or they'd be deleted with it. Keep their visual
    // order: if prevBlock is the merged block's parent, slot them where the merged
    // block was (before its later siblings); otherwise append them after
    // prevBlock's existing (possibly collapsed) children.
    const children = current.filter(b => b.parent_id === blockId).sort((a, b) => a.position - b.position);
    let movedChildren: { id: string; fromParentId: string; fromPosition: number; toParentId: string; toPosition: number }[] = [];
    if (children.length) {
      const n = children.length;
      let target: (i: number) => number;
      if (merged.parent_id === prevBlock.id) {
        const later = current
          .filter(b => b.parent_id === prevBlock.id && b.id !== blockId && b.position > merged.position)
          .map(b => b.position);
        const lo = merged.position;
        const hi = later.length ? Math.min(...later) : undefined;
        target = i => hi === undefined ? lo + i + 1 : lo + ((hi - lo) * (i + 1)) / (n + 1);
      } else {
        const existing = current.filter(b => b.parent_id === prevBlock.id).map(b => b.position);
        const lo = existing.length ? Math.max(...existing) : 0;
        target = i => lo + i + 1;
      }
      movedChildren = children.map((c, i) => ({
        id: c.id, fromParentId: blockId, fromPosition: c.position, toParentId: prevBlock.id, toPosition: target(i),
      }));
    }
    // Snapshot ONLY the merged block (its children survive, re-homed) before it
    // goes, so undo can bring it back with its original id. Taken inside the op
    // queue (after any pending create resolved), with temp ids mapped to real ones.
    const snapshotOf = () => {
      const mapped = current.map(b => ({ ...b, id: rid(b.id), parent_id: b.parent_id ? rid(b.parent_id) : b.parent_id }));
      return api.snapshotSubtrees([rid(blockId)], mapped).then(rs => rs.filter(r => r.id === rid(blockId)));
    };
    // Optimistically merge + remove locally so a full page refresh isn't needed
    // (the refresh would discard other in-progress optimistic edits).
    markEdited(prevBlock.id, mergedContent);
    pendingDeletesRef.current.set(blockId, Date.now());
    const moves = new Map(movedChildren.map(m => [m.id, m]));
    setLocalBlocks(prev => prev
      .map(b => {
        if (b.id === prevBlock.id) return { ...b, content: mergedContent };
        const m = moves.get(b.id);
        return m ? { ...b, parent_id: m.toParentId, position: m.toPosition } : b;
      })
      .filter(b => b.id !== blockId));
    setFocusBlockId(prevBlock.id);
    await enqueue(async () => {
      try {
        // The editor text (`content`) may be newer than the last saved block content.
        const restore = (await snapshotOf()).map(r => (r.id === rid(blockId) ? { ...r, content } : r));
        const realMoves = movedChildren.map(m => ({ ...m, id: rid(m.id), fromParentId: rid(m.fromParentId), toParentId: rid(m.toParentId) }));
        await api.updateBlock(rid(prevBlock.id), mergedContent);
        for (const m of realMoves) await api.moveBlock(m.id, m.toParentId, m.toPosition);
        await api.deleteBlock(rid(blockId));
        undoStack.push({ type: 'merge', blockId: rid(prevBlock.id), pageId: page.id, oldContent: prevOldContent, newContent: mergedContent, restore, movedChildren: realMoves, timestamp: Date.now() });
      } catch (e) {
        console.error("Backspace merge failed:", e);
        showToast("Could not merge blocks — check connection.");
        onRefreshPage();
      }
    });
  };

  // BlockItem is memoized without comparing callbacks, so handlers must read live
  // state through refs, never the render closure.
  const handleArrowUp = (blockId: string) => {
    const list = visibleRef.current;
    const idx = list.findIndex(b => b.id === blockId);
    if (idx > 0) setFocusBlockId(list[idx - 1].id);
  };

  const handleArrowDown = (blockId: string) => {
    const list = visibleRef.current;
    const idx = list.findIndex(b => b.id === blockId);
    if (idx >= 0 && idx < list.length - 1) setFocusBlockId(list[idx + 1].id);
  };

  // UX-012: Smart paste — split multi-line paste into multiple blocks
  const handlePasteMultiline = async (blockId: string, lines: string[]) => {
    const current = localBlocksRef.current;
    const block = current.find(b => b.id === blockId);
    if (!block) return;
    // Inherit parent_id from the block being pasted into, so pasted lines
    // stay at the same indent level rather than being flattened to root.
    const parentId = block.parent_id ?? undefined;
    // Place the lines right after the current block, in order (not at page end).
    const positions = positionsAfter(current, block, lines.length);
    const lastId = await enqueue(async () => {
      const realParent = parentId ? rid(parentId) : undefined;
      let last: string | null = null;
      for (let i = 0; i < lines.length; i++) {
        let created = await api.createBlock(page.id, lines[i], realParent);
        if (positions) created = await api.reorderBlock(created.id, realParent, positions[i]);
        last = created.id;
      }
      return last;
    });
    onRefreshPage();
    if (lastId) setFocusBlockId(lastId);
  };

  // UX-002: Block indent/outdent. Applied locally first (and the editor refocused
  // at the same caret in the same keystroke — a moved DOM node loses focus), then
  // persisted through the op queue.
  const moveBlockLocally = (blockId: string, parentId: string | undefined, position: number) => {
    const caret = blockRefs.current.get(blockId)?.getCaret() ?? null;
    flushSync(() => {
      setLocalBlocks(prev => outlineOrder(prev.map(b => b.id === blockId ? { ...b, parent_id: parentId, position } : b)));
    });
    blockRefs.current.get(blockId)?.focus(caret ?? "end");
  };

  const handleIndent = (blockId: string) => {
    const current = localBlocksRef.current;
    const flatIdx = current.findIndex(b => b.id === blockId);
    if (flatIdx <= 0) return; // Can't indent first block
    const block = current[flatIdx];
    const parentKey = block.parent_id ?? null;
    // Previous sibling: the nearest earlier block with the same parent.
    const prevSibling = current.slice(0, flatIdx).reverse().find(b => (b.parent_id ?? null) === parentKey);
    if (!prevSibling) return; // No sibling above to become parent
    // Becomes the LAST child of the previous sibling (positions are per parent).
    const kidPositions = current.filter(b => b.parent_id === prevSibling.id).map(b => b.position);
    const position = kidPositions.length ? Math.max(...kidPositions) + 1 : 1;
    if (collapsedBlocksRef.current.has(prevSibling.id)) toggleCollapse(prevSibling.id);
    moveBlockLocally(blockId, prevSibling.id, position);
    enqueue(() => api.moveBlock(rid(blockId), rid(prevSibling.id), position))
      .then(() => onRefreshPage())
      .catch((e) => { console.error("indent failed:", e); showToast("Could not indent block"); onRefreshPage(); });
  };

  const handleOutdent = (blockId: string) => {
    const current = localBlocksRef.current;
    const block = current.find(b => b.id === blockId);
    if (!block?.parent_id) return; // Already at root level
    const parent = current.find(b => b.id === block.parent_id);
    if (!parent) return;
    // Goes directly after its former parent, among the parent's siblings — strictly
    // between the parent and the parent's next sibling, so positions stay distinct.
    const grandParentId = parent.parent_id ?? undefined;
    const position = positionsAfter(current, parent, 1)?.[0] ?? parent.position + 1;
    moveBlockLocally(blockId, grandParentId, position);
    enqueue(() => api.reorderBlock(rid(blockId), grandParentId ? rid(grandParentId) : undefined, position))
      .then(() => onRefreshPage())
      .catch((e) => { console.error("outdent failed:", e); showToast("Could not outdent block"); onRefreshPage(); });
  };

  // Escape in a block: leave editing, keep the block selected so the keyboard can
  // carry on (arrows move the selection, Enter edits, Backspace deletes).
  const handleEscape = (blockId: string) => {
    blockRefs.current.get(blockId)?.blur();
    const idx = visibleRef.current.findIndex(b => b.id === blockId);
    setSelectedBlockIds(new Set([blockId]));
    setSelectionAnchor(idx >= 0 ? idx : null);
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

  const collapsedBlocksRef = useRef(collapsedBlocks);
  collapsedBlocksRef.current = collapsedBlocks;

  // Re-read from localStorage when the page changes, and whenever another view
  // (the mind map shares this entry) or another window changes it.
  useEffect(() => {
    const key = "minotes-collapsed-" + page.id;
    const read = () => {
      try {
        const stored = localStorage.getItem(key);
        const next = new Set(stored ? JSON.parse(stored) as string[] : []);
        setCollapsedBlocks(prev => (prev.size === next.size && [...next].every(id => prev.has(id)) ? prev : next));
      } catch {
        setCollapsedBlocks(new Set());
      }
    };
    read();
    const onChanged = (e: Event) => {
      const pid = (e as CustomEvent<{ pageId?: string }>).detail?.pageId;
      if (!pid || pid === page.id) read();
    };
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === key) read(); };
    window.addEventListener("minotes-collapse-changed", onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("minotes-collapse-changed", onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [page.id]);

  const toggleCollapse = (blockId: string) => {
    // Start from the stored entry (kept in step with every toggle): the mind map
    // may have changed it since we read it. Computed outside the state updater —
    // updaters must be pure (StrictMode runs them twice).
    const key = "minotes-collapsed-" + page.id;
    let prev = collapsedBlocksRef.current;
    try {
      const stored = localStorage.getItem(key);
      if (stored) prev = new Set(JSON.parse(stored) as string[]);
    } catch {}
    const next = new Set(prev);
    if (next.has(blockId)) next.delete(blockId); else next.add(blockId);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch {}
    collapsedBlocksRef.current = next;
    setCollapsedBlocks(next);
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
    // collapsedBlocks is read by isHiddenByCollapse — without it here, collapsing
    // never hid children (stale memo).
  }, [blocks, collapsedBlocks]);

  // One stable ref callback per block: a new inline callback on every render made
  // React detach/re-attach every block's ref AND defeated BlockItem's memo (a
  // changed ref re-renders the component), so any PageView render re-rendered
  // every block of the page.
  const refCallbacksRef = useRef<Map<string, (el: BlockItemHandle | null) => void>>(new Map());
  const refFor = (id: string) => {
    let cb = refCallbacksRef.current.get(id);
    if (!cb) {
      cb = (el) => { if (el) blockRefs.current.set(id, el); else if (blockRefs.current.get(id)) blockRefs.current.delete(id); };
      refCallbacksRef.current.set(id, cb);
    }
    return cb;
  };

  // Prune refs for blocks that no longer exist (the ref callback adds new ones).
  useEffect(() => {
    const ids = new Set(blocks.map(b => b.id));
    for (const key of Array.from(blockRefs.current.keys())) {
      if (!ids.has(key)) blockRefs.current.delete(key);
    }
    for (const key of Array.from(refCallbacksRef.current.keys())) {
      if (!ids.has(key)) refCallbacksRef.current.delete(key);
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

  // Zoom in/out keeps the keyboard where it was: the block that had focus (or the
  // block we just zoomed out of) gets it back.
  const zoomTo = (id: string | null, focusId?: string | null) => {
    const target = focusId ?? zoomedBlockId;
    const caret = target ? blockRefs.current.get(target)?.getCaret() ?? null : null;
    setZoomedBlockId(id);
    if (target) focusBlockAt(target, caret ?? "end");
  };

  // Memoized: PageView re-renders for many reasons (save indicator, active block,
  // selection) that don't change which blocks are visible.
  const filteredVisibleBlocks = useMemo(() => {
    const visibleBlocks = zoomedBlockId
      ? getDescendants(blocks, zoomedBlockId)
      : blocks;
    // Filter visible blocks (exclude collapsed children + duplicate H1 title)
    return visibleBlocks.filter((b, idx) => {
      if (blockTreeInfo.isHiddenByCollapse(b.id)) return false;
      // Hide first block if it's an H1 matching the page title (redundant with header)
      if (idx === 0 && !b.parent_id) {
        const trimmed = b.content.trim();
        if (trimmed.startsWith("# ") && trimmed.slice(2).trim() === page.title) return false;
      }
      return true;
    });
  }, [blocks, zoomedBlockId, blockTreeInfo, page.title]);
  const visibleRef = useRef(filteredVisibleBlocks);
  visibleRef.current = filteredVisibleBlocks;

  // Progressive rendering: after each commit, schedule the next slice until every
  // visible block is in the DOM; slice size adapts to keep each one ~SLICE_BUDGET_MS.
  const visibleCount = filteredVisibleBlocks.length;
  useLayoutEffect(() => {
    const sl = sliceRef.current;
    if (sl.startedAt) {
      const took = performance.now() - sl.startedAt;
      sl.startedAt = 0;
      if (took > 0) sl.size = Math.max(25, Math.min(1000, Math.round(sl.size * SLICE_BUDGET_MS / took)));
    }
  }, [renderLimit]);
  useEffect(() => {
    if (renderLimit >= visibleCount) return;
    const pageId = page.id;
    const t = setTimeout(() => {
      sliceRef.current.startedAt = performance.now();
      setRenderState(prev => ({
        pageId,
        limit: (prev.pageId === pageId ? prev.limit : INITIAL_RENDER) + sliceRef.current.size,
      }));
    }, 0);
    return () => clearTimeout(t);
  }, [renderLimit, visibleCount, page.id]);
  /** Make sure the block is rendered (big pages render progressively). True if it wasn't. */
  const ensureRendered = (id: string): boolean => {
    const idx = visibleRef.current.findIndex(b => b.id === id || b.id === rid(id));
    if (idx < renderLimitRef.current) return false;
    const pageId = page.id;
    setRenderState({ pageId, limit: idx + INITIAL_RENDER });
    return true;
  };

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
        let el = document.querySelectorAll('.ProseMirror')[blockIndex];
        if (!el) return false;
        // A block that isn't being edited renders statically: mount its editor first.
        if (el.classList.contains('block-static')) {
          const id = el.closest('[data-block-id]')?.getAttribute('data-block-id');
          if (!id || !blockRefs.current.get(id)?.ensureEditor()) return false;
          el = document.querySelectorAll('.ProseMirror')[blockIndex];
          if (!el) return false;
        }
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
        // Queried after focus(): a static block's editor was only just mounted.
        const el = document.querySelector(`[data-block-id="${CSS.escape(block.id)}"] .ProseMirror`);
        if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return true;
      },
      // A keydown into block N's editor — ProseMirror runs its key handlers for it,
      // i.e. the same code path as the real key (Tab, Escape, Enter...).
      pressKeyInBlock: (blockIndex: number, key: string, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; focus?: boolean } = {}) => {
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
        if (!ref) return false;
        let el = document.querySelector(`[data-block-id="${CSS.escape(block.id)}"] .ProseMirror`);
        if (!el) return false;
        if (mods.focus !== false && !el.contains(document.activeElement)) ref.focus();
        else ref.ensureEditor();
        // Re-query: a static block's editor may have just been mounted in its place.
        el = document.querySelector(`[data-block-id="${CSS.escape(block.id)}"] .ProseMirror`);
        if (!el) return false;
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true,
          shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
        }));
        return true;
      },
      // Visible blocks with their nesting (depth) and parent's visible index.
      getBlockTree: () => filteredVisibleBlocks.map((b, i) => ({
        index: i, content: b.content, depth: blockTreeInfo.getDepth(b.id),
        parentIndex: b.parent_id ? filteredVisibleBlocks.findIndex(p => p.id === b.parent_id) : -1,
        id: b.id, position: b.position,
      })),
      // Index of the visible block whose editor has focus (-1: none).
      getFocusedBlockIndex: () => {
        const id = (document.activeElement as HTMLElement | null)?.closest?.('.ProseMirror')
          ?.closest('[data-block-id]')?.getAttribute('data-block-id');
        return id ? filteredVisibleBlocks.findIndex(b => b.id === id) : -1;
      },
      getSelectedIndices: () => filteredVisibleBlocks.map((b, i) => (selectedBlockIds.has(b.id) ? i : -1)).filter(i => i >= 0),
      // Follow a ((block ref)) — the click handler of a block ref / transclusion.
      openBlockRef: (blockId: string) => { handleBlockRefClick(blockId); return true; },
      focusBlock: (blockIndex: number) => {
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
        if (ref) { ref.focus(); return true; }
        return false;
      },
      getBlockCount: () => filteredVisibleBlocks.length,
      // The following drive the SAME code paths as the keyboard handlers
      // (ProseMirror ignores synthetic CDP key events).
      splitBlockAt: (blockIndex: number, offset: number) => {
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
        return ref ? ref.splitAt(offset) : false;
      },
      mergeWithPrevious: (blockIndex: number) => {
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
        return ref ? ref.mergeWithPrevious() : false;
      },
      toggleTodoInBlock: (blockIndex: number) => {
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
        if (!ref) return false;
        ref.toggleTodo();
        return true;
      },
      getLiveBlockContent: (blockIndex: number) => {
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
        return ref ? ref.getMarkdown() : null;
      },
      toggleCollapseBlock: (blockIndex: number) => {
        const block = filteredVisibleBlocks[blockIndex];
        if (!block) return false;
        toggleCollapse(block.id);
        return true;
      },
      selectBlocks: (fromIndex: number, toIndex: number) => {
        const ids = filteredVisibleBlocks.slice(fromIndex, toIndex + 1).map(b => b.id);
        setSelectedBlockIds(new Set(ids));
        setSelectionAnchor(fromIndex);
        return ids.length;
      },
      getSelectedCount: () => selectedBlockIds.size,
      // Table structure command at the cursor in block N (toolbar / context-menu path).
      tableAction: (blockIndex: number, action: string) => {
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
        return ref ? ref.tableAction(action as any) : false;
      },
      // Make / remove block N's flashcard (context-menu path).
      setFlashcard: (blockIndex: number, on: boolean) => {
        const block = filteredVisibleBlocks[blockIndex];
        const ref = block ? blockRefs.current.get(block.id) : null;
        return ref ? ref.setFlashcard(on) : Promise.resolve(false);
      },
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
  }, [filteredVisibleBlocks, selectedBlockIds]);

  // UX-006: Zoom keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Escape outside any editor/input with nothing selected leaves the zoom.
      if (e.key === "Escape" && zoomedBlockId && !e.defaultPrevented && selectedCountRef.current === 0) {
        const t = e.target as HTMLElement | null;
        if (!t || t === document.body || !t.closest?.("input, textarea, [contenteditable='true'], .ProseMirror, [role='dialog']")) {
          e.preventDefault();
          zoomTo(null);
        }
        return;
      }
      if (!e.altKey) return;
      if (e.key === "ArrowRight") {
        const activeEl = document.activeElement?.closest(".block");
        if (activeEl) {
          const blockId = activeEl.getAttribute("data-block-id");
          if (blockId) {
            e.preventDefault();
            zoomTo(blockId, blockId);
          }
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (zoomedBlockId) {
          const current = blocks.find(b => b.id === zoomedBlockId);
          const activeId = document.activeElement?.closest(".block")?.getAttribute("data-block-id") ?? null;
          zoomTo(current?.parent_id ?? null, activeId ?? zoomedBlockId);
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
    // Selection mode: move focus out of the editor so Backspace/Delete/Ctrl+C act on
    // the selected blocks (keys inside an editor are left to the editor).
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest?.(".ProseMirror, .cm-editor")) active.blur();
    const anchor = selectionAnchor ?? clickedIdx;
    const start = Math.min(anchor, clickedIdx);
    const end = Math.max(anchor, clickedIdx);
    const ids = new Set(filteredVisibleBlocks.slice(start, end + 1).map(b => b.id));
    setSelectedBlockIds(ids);
    setSelectionAnchor(anchor);
  }, [filteredVisibleBlocks, selectionAnchor]);

  // BlockItem keeps the first callbacks it was given (memo ignores them): these
  // stable wrappers always call the current handler.
  const shiftClickRef = useRef(handleShiftClick);
  shiftClickRef.current = handleShiftClick;
  const handleShiftClickLive = useCallback((id: string) => shiftClickRef.current(id), []);
  const dragReorderRef = useRef(handleDragReorder);
  dragReorderRef.current = handleDragReorder;
  const handleDragReorderLive = useCallback(
    (dragged: string, target: string, pos: "above" | "below") => dragReorderRef.current(dragged, target, pos), []);

  // UX-013: Block ref click handler — navigate to the block's page
  // Read through a ref: BlockItem (memoized) keeps the first callback it got.
  const handleBlockRefClick = useCallback((blockId: string) => {
    if (localBlocksRef.current.some(b => b.id === blockId)) {
      revealBlockRef.current(blockId);
      return;
    }
    // Another page: look the block up by id (search can't find a block by its id),
    // open its page, and reveal it once that page has rendered.
    api.getBlock(blockId).then(async (b) => {
      if (!b) { showToast("The referenced block no longer exists"); return; }
      // get_block carries page_title (BlockWithPage); fall back to a tree lookup.
      const title = (b as any).page_title ?? (await api.getPageTree(b.page_id)).page.title;
      setPendingReveal(blockId);
      onPageLinkClickRef.current(title);
    }).catch((e) => {
      console.error("block ref navigation failed:", e);
      showToast("Could not open the referenced block");
    });
  }, []);

  // Scroll to a block on this page, expand/unzoom so it's visible, highlight it
  // briefly and put the caret in it.
  const revealBlock = (blockId: string) => {
    const all = localBlocksRef.current;
    const byId = new Map(all.map(b => [b.id, b]));
    const ancestors: string[] = [];
    let pid = byId.get(blockId)?.parent_id ?? null;
    while (pid) { ancestors.push(pid); pid = byId.get(pid)?.parent_id ?? null; }
    const collapsedAncestors = ancestors.filter(a => collapsedBlocksRef.current.has(a));
    collapsedAncestors.forEach(a => toggleCollapse(a));
    if (zoomedBlockId && zoomedBlockId !== blockId && !ancestors.includes(zoomedBlockId)) setZoomedBlockId(null);
    ensureRendered(blockId);
    focusBlockAt(blockId, "end");
    // Big pages render progressively: wait (briefly) for the block to exist.
    let tries = 0;
    const highlight = () => {
      const el = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`) as HTMLElement | null;
      if (!el) { if (++tries < 40) setTimeout(highlight, 50); return; }
      el.scrollIntoView({ block: "center" });
      el.classList.add("block-ref-highlight");
      setTimeout(() => el.classList.remove("block-ref-highlight"), 1600);
    };
    setTimeout(highlight, 60);
  };
  const revealBlockRef = useRef(revealBlock);
  revealBlockRef.current = revealBlock;
  const onPageLinkClickRef = useRef(onPageLinkClick);
  onPageLinkClickRef.current = onPageLinkClick;

  // UX-013: Batch operations on multi-block selection
  const deleteSelected = useCallback(async () => {
    // Blocks created by a just-pressed Enter must exist before they can be deleted.
    await opQueueRef.current;
    const current = localBlocksRef.current;
    const toDelete = current.filter(b => selectedBlockIds.has(b.id) || [...selectedBlockIds].some(s => rid(s) === b.id));
    setSelectedBlockIds(new Set());
    setSelectionAnchor(null);
    if (toDelete.length === 0) return;
    // One undo entry for the whole group: every selected block plus its whole
    // subtree (deleteBlock cascades), parents-first, with properties. Undo
    // restores them all in one call with their original ids and positions.
    let snapshot: api.RestoreBlock[] = [];
    try {
      snapshot = await api.snapshotSubtrees(toDelete.map(b => rid(b.id)), current);
    } catch (e) {
      console.error("deleteSelected snapshot failed:", e);
    }
    const gone = new Set<string>();
    for (const b of toDelete) {
      // Already removed as part of an earlier selected ancestor's subtree.
      if (gone.has(b.id)) continue;
      try {
        await api.deleteBlock(b.id);
        // Mark this block's whole subtree as deleted.
        let grew = true;
        gone.add(b.id);
        while (grew) {
          grew = false;
          for (const s of snapshot) {
            if (s.parent_id && gone.has(s.parent_id) && !gone.has(s.id)) { gone.add(s.id); grew = true; }
          }
        }
      } catch (e) {
        console.error("deleteSelected failed:", e);
      }
    }
    const restore = snapshot.filter(s => gone.has(s.id));
    if (restore.length > 0) {
      undoStack.push({ type: 'delete', blockId: restore[0].id, pageId: page.id, restore, timestamp: Date.now() });
    }
    onRefreshPage();
  }, [selectedBlockIds, onRefreshPage, page.id]);

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
    const isEditingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || typeof el.closest !== "function") return false;
      return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
        !!el.closest('[contenteditable="true"], .ProseMirror, .cm-editor, input, textarea');
    };
    const handler = (e: KeyboardEvent) => {
      // Keys typed inside an editor/input belong to that editor: Backspace must
      // delete a character, not every selected block; Ctrl+C copies the text.
      if (isEditingTarget(e.target)) return;
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
      // Keyboard navigation of the selection (e.g. after Escape left a block):
      // arrows move it (Shift extends), Enter edits the selected block.
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const list = visibleRef.current;
        const idxs = list.map((b, i) => (selectedBlockIds.has(b.id) ? i : -1)).filter(i => i >= 0);
        if (idxs.length === 0) return;
        e.preventDefault();
        const up = e.key === "ArrowUp";
        const edge = up ? Math.min(...idxs) : Math.max(...idxs);
        const next = Math.max(0, Math.min(list.length - 1, edge + (up ? -1 : 1)));
        if (e.shiftKey) {
          const anchor = selectionAnchor ?? edge;
          const lo = Math.min(anchor, next), hi = Math.max(anchor, next);
          setSelectedBlockIds(new Set(list.slice(lo, hi + 1).map(b => b.id)));
          setSelectionAnchor(anchor);
        } else {
          setSelectedBlockIds(new Set([list[next].id]));
          setSelectionAnchor(next);
        }
        list[next] && document.querySelector(`[data-block-id="${CSS.escape(list[next].id)}"]`)?.scrollIntoView({ block: "nearest" });
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && selectedBlockIds.size === 1) {
        e.preventDefault();
        const [id] = [...selectedBlockIds];
        setSelectedBlockIds(new Set());
        setSelectionAnchor(null);
        blockRefs.current.get(id)?.focus("end");
      }
    };
    // A plain click into an editor ends the block selection (shift-click extends it).
    const mouseHandler = (e: MouseEvent) => {
      if (e.shiftKey) return;
      if (isEditingTarget(e.target)) {
        setSelectedBlockIds(new Set());
        setSelectionAnchor(null);
      }
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("mousedown", mouseHandler, true);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("mousedown", mouseHandler, true);
    };
  }, [selectedBlockIds, selectionAnchor, deleteSelected, copySelected]);

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

  const selectedCountRef = useRef(0);
  selectedCountRef.current = selectedBlockIds.size;

  // Redo (Ctrl+Shift+Z / Ctrl+Y) outside an editor: the block-level undo stack.
  // Inside an editor the editor's own history redoes text. Capture phase, and the
  // event stops here so a second (global) redo handler can't apply it twice.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const isRedo = (k === "z" && e.shiftKey) || (k === "y" && !e.shiftKey);
      if (!isRedo) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
          t.closest?.(".ProseMirror, .cm-editor"))) return;
      e.preventDefault();
      e.stopPropagation();
      executeRedo()
        .then((did) => { if (did) onRefreshPageRef.current(); else showToast("Nothing to redo"); })
        .catch((err) => { console.error("redo failed:", err); showToast("Redo failed"); onRefreshPageRef.current(); });
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  const onRefreshPageRef = useRef(onRefreshPage);
  onRefreshPageRef.current = onRefreshPage;

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

  // The block list only changes with the blocks, the tree, the selection and the
  // render limit — not on the many other PageView state changes (save indicator,
  // active block, suggestions). BlockItem is memoized and ignores callback props,
  // so the handlers below read live state through refs.
  const blockListItems = useMemo(() => filteredVisibleBlocks.slice(0, renderLimit).map((block, idx) => (
    <BlockItem
      key={renderKeyRef.current.get(block.id) ?? block.id}
      ref={refFor(block.id)}
      block={block}
      depth={blockTreeInfo.getDepth(block.id)}
      dataBlockId={block.id}
      selected={selectedBlockIds.has(block.id)}
      onUpdate={handleBlockUpdate}
      onDelete={onDeleteBlock}
      onPageLinkClick={handlePageLinkClick}
      onBlockRefClick={handleBlockRefClick}
      onEnter={handleEnter}
      canEnter={canEnter}
      onBackspaceAtStart={handleBackspaceAtStart}
      onArrowUp={handleArrowUp}
      onArrowDown={handleArrowDown}
      onPasteMultiline={handlePasteMultiline}
      onIndent={handleIndent}
      onOutdent={handleOutdent}
      onEscape={handleEscape}
      onDuplicate={handleDuplicate}
      onToggleCollapse={toggleCollapse}
      onZoomIn={() => zoomTo(block.id, block.id)}
      hasChildren={blockTreeInfo.hasChildren(block.id)}
      isLastSibling={(() => {
        const next = filteredVisibleBlocks[idx + 1];
        if (!next) return true;
        return (next.parent_id ?? null) !== (block.parent_id ?? null);
      })()}
      isOnActivePath={false}
      onFocusBlock={(id) => { lastEditorBlockIdRef.current = id; setActiveBlockId(id); }}
      onBlurBlock={() => {
        // Only clear if no other block takes focus within 100ms
        // Prevents flash when clicking between blocks
        setTimeout(() => {
          if (activeBlockIdRef.current === block.id) {
            setActiveBlockId(null);
          }
        }, 100);
      }}
      onShiftClick={handleShiftClickLive}
      onOpenWhiteboard={onOpenWhiteboard}
      onDragReorder={handleDragReorderLive}
    />
  // eslint-disable-next-line react-hooks/exhaustive-deps
  )), [filteredVisibleBlocks, renderLimit, selectedBlockIds, blockTreeInfo]);

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
            <button className="btn btn-sm" onClick={() => onJournalNav(localDateKey())}>Today</button>
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
          <span className="breadcrumb-item" onClick={() => zoomTo(null)}>
            {page.title}
          </span>
          {getBreadcrumbs(blocks, zoomedBlockId).map(b => (
            <span key={b.id}>
              <span className="breadcrumb-sep"> &rsaquo; </span>
              <span className="breadcrumb-item" onClick={() => zoomTo(b.id)}>
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
                    const before = pageProps;
                    api.setProperty(page.id, "page", "tags", newTags).catch((e) => {
                      setPageProps(before);
                      showToast(`Tag not added: ${propError(e)}`);
                    });
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
              <span key={s.pageId} className="ai-link-chip" title={`Suggested because it ${s.reason}`}>
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
        <div className={`block-list ${getSettingsCached().fullTreeMode ? 'tree-mode' : ''}`}>
          {blockListItems}

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
