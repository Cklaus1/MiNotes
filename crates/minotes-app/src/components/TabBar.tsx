import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { rankByFuzzy } from "../lib/fuzzy";
import { useLayer } from "../lib/layers";
import type { TabBarItem } from "../lib/tabBarTypes";
import Icon from "./Icon";
import "./tabs.css";

export type { TabBarItem } from "../lib/tabBarTypes";

interface Props {
  tabs: TabBarItem[];
  activeId: string;
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNewTab(): void;
  onCloseOthers(id: string): void;
  onCloseRight(id: string): void;
  onTogglePin(id: string): void;
  onDuplicate(id: string): void;
  onReopenClosed(): void;
  canReopen: boolean;
  /** `toIndex` is the tab's index in the list after the move (remove, then insert). */
  onMove(id: string, toIndex: number, pinned: boolean): void;
  /** Narrow window (<900 px): only the active tab (its title fills the row), ← →, +, ⌄. */
  compact?: boolean;
}

const DRAG_THRESHOLD = 5;

interface DragState {
  id: string;
  startX: number;
  pointerId: number;
  active: boolean;
}

/**
 * The tab row (PRD-tabs §3.1, §3.5, §3.6, §4.9). Presentational: the tab list
 * and every action come in as props (lib/tabs.ts owns the state).
 */
export default function TabBar({
  tabs, activeId, canBack, canForward, onBack, onForward, onActivate, onClose, onNewTab,
  onCloseOthers, onCloseRight, onTogglePin, onDuplicate, onReopenClosed, canReopen, onMove, compact = false,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabEls = useRef(new Map<string, HTMLDivElement>());
  const [overflowing, setOverflowing] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [slot, setSlot] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const drag = useRef<DragState | null>(null);
  const justDragged = useRef(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  const single = tabs.length === 1;
  const shown = compact ? tabs.filter((t) => t.id === activeId) : tabs;

  // Overflow: does the scroller hold more than it shows?
  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (el) setOverflowing(el.scrollWidth > el.clientWidth + 1);
  }, []);
  useLayoutEffect(measure, [measure, tabs, compact]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // The active tab is always in view.
  useEffect(() => {
    tabEls.current.get(activeId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length, compact]);

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeList = useCallback(() => setListOpen(false), []);
  useLayer(menu !== null, "menu", closeMenu);
  useLayer(listOpen, "popover", closeList);

  // ── Drag to reorder (pointer events) ──
  const slotAt = (clientX: number): number => {
    let s = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabEls.current.get(tabs[i].id)?.getBoundingClientRect();
      if (r && clientX < r.left + r.width / 2) { s = i; break; }
    }
    return s;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0 || compact || tabs.length < 2) return;
    drag.current = { id, startX: e.clientX, pointerId: e.pointerId, active: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD) return;
      d.active = true;
      setDraggingId(d.id);
      try { e.currentTarget.setPointerCapture?.(d.pointerId); } catch { /* not capturable */ }
    }
    setSlot(slotAt(e.clientX));
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    try { e.currentTarget.releasePointerCapture?.(d.pointerId); } catch { /* already released */ }
    if (!d.active) return;
    justDragged.current = true;
    window.setTimeout(() => { justDragged.current = false; }, 0);
    setDraggingId(null);
    setSlot(null);
    if (!commit) return;
    const from = tabs.findIndex((t) => t.id === d.id);
    if (from < 0) return;
    const s = slotAt(e.clientX);
    const pinnedCount = tabs.filter((t) => t.pinned).length;
    // Inside the pinned group → pinned; past it → not; on the boundary → unchanged.
    const pinned = s < pinnedCount ? true : s > pinnedCount ? false : tabs[from].pinned;
    const to = s > from ? s - 1 : s;
    if (to === from && pinned === tabs[from].pinned) return;
    onMove(d.id, to, pinned);
  };

  // ── Keyboard on the tabs ──
  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(id);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const i = shown.findIndex((t) => t.id === id);
      const next = shown[i + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) tabEls.current.get(next.id)?.focus();
    }
  };

  const menuTab = menu ? tabs.find((t) => t.id === menu.id) : undefined;
  const menuIndex = menuTab ? tabs.indexOf(menuTab) : -1;
  const closableOthers = menuTab ? tabs.some((t) => t.id !== menuTab.id && !t.pinned) : false;
  const closableRight = menuTab ? tabs.slice(menuIndex + 1).some((t) => !t.pinned) : false;

  return (
    <div
      className={`tabbar${single ? " tabbar-single" : ""}${compact ? " tabbar-compact" : ""}`}
      data-testid="tabbar"
    >
      <div className="tabbar-nav" role="group" aria-label="History">
        <button className="tabbar-btn" onClick={onBack} disabled={!canBack} title="Back (Ctrl+[)" aria-label="Back" data-testid="tab-back">
          <Icon name="arrow-left" size={15} />
        </button>
        <button className="tabbar-btn" onClick={onForward} disabled={!canForward} title="Forward (Ctrl+])" aria-label="Forward" data-testid="tab-forward">
          <Icon name="arrow-right" size={15} />
        </button>
      </div>

      <div ref={scrollerRef} className="tabbar-tabs" role="tablist" aria-label="Open tabs">
        {shown.map((t, i) => {
          const active = t.id === activeId;
          const gap = slot === null || draggingId === null ? "" :
            slot === i ? " tab-drop-before" : slot === tabs.length && i === tabs.length - 1 ? " tab-drop-after" : "";
          return (
            <div
              key={t.id}
              ref={(el) => { if (el) tabEls.current.set(t.id, el); else tabEls.current.delete(t.id); }}
              className={`tab${active ? " tab-active" : ""}${t.pinned ? " tab-pinned" : ""}${draggingId === t.id ? " tab-dragging" : ""}${gap}`}
              role="tab"
              aria-selected={active}
              aria-label={t.pinned ? t.fullTitle : undefined}
              tabIndex={active ? 0 : -1}
              title={t.fullTitle}
              data-tab-id={t.id}
              data-testid="tab"
              onClick={() => { if (!justDragged.current) onActivate(t.id); }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                if (!single) onClose(t.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setListOpen(false);
                setMenu({ id: t.id, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => onTabKeyDown(e, t.id)}
              onPointerDown={(e) => onPointerDown(e, t.id)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => endDrag(e, true)}
              onPointerCancel={(e) => endDrag(e, false)}
            >
              <Icon name={t.icon} size={14} className="tab-icon" />
              {!t.pinned && <span className="tab-title">{t.title}</span>}
              {!t.pinned && !single && (
                <button
                  className="tab-x"
                  tabIndex={-1}
                  aria-label={`Close ${t.fullTitle}`}
                  title="Close tab (Ctrl+W)"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button className="tabbar-btn tabbar-plus" onClick={onNewTab} title="New tab (Ctrl+T)" aria-label="New tab" data-testid="tab-new">
        <Icon name="plus" size={15} />
      </button>
      <div className="tabbar-spacer" />
      {(overflowing || compact) && (
        <button
          ref={moreRef}
          className="tabbar-btn tabbar-more"
          onClick={() => { setMenu(null); setListOpen((o) => !o); }}
          title="All open tabs"
          aria-label="All open tabs"
          aria-haspopup="listbox"
          aria-expanded={listOpen}
          data-testid="tab-more"
        >
          <Icon name="chevron-down" size={15} />
        </button>
      )}

      {menu && menuTab && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          pinned={menuTab.pinned}
          canClose={!single}
          canCloseOthers={closableOthers}
          canCloseRight={closableRight}
          canReopen={canReopen}
          onDismiss={closeMenu}
          onClose={() => onClose(menuTab.id)}
          onCloseOthers={() => onCloseOthers(menuTab.id)}
          onCloseRight={() => onCloseRight(menuTab.id)}
          onTogglePin={() => onTogglePin(menuTab.id)}
          onDuplicate={() => onDuplicate(menuTab.id)}
          onReopenClosed={onReopenClosed}
        />
      )}
      {listOpen && (
        <TabList
          tabs={tabs}
          activeId={activeId}
          anchor={moreRef.current}
          onDismiss={closeList}
          onPick={(id) => { setListOpen(false); onActivate(id); }}
        />
      )}
    </div>
  );
}

function TabMenu({
  x, y, pinned, canClose, canCloseOthers, canCloseRight, canReopen, onDismiss,
  onClose, onCloseOthers, onCloseRight, onTogglePin, onDuplicate, onReopenClosed,
}: {
  x: number; y: number; pinned: boolean;
  canClose: boolean; canCloseOthers: boolean; canCloseRight: boolean; canReopen: boolean;
  onDismiss(): void; onClose(): void; onCloseOthers(): void; onCloseRight(): void;
  onTogglePin(): void; onDuplicate(): void; onReopenClosed(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onDismiss]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  const run = (fn: () => void) => () => { onDismiss(); fn(); };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const n = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[n].focus();
  };

  return (
    <div ref={ref} className="tab-menu" role="menu" style={{ left: x, top: y }} onKeyDown={onKeyDown} data-testid="tab-menu">
      <button className="tab-menu-item" role="menuitem" disabled={!canClose} onClick={run(onClose)}>
        <span>Close</span><kbd>Ctrl+W</kbd>
      </button>
      <button className="tab-menu-item" role="menuitem" disabled={!canCloseOthers} onClick={run(onCloseOthers)}>Close other tabs</button>
      <button className="tab-menu-item" role="menuitem" disabled={!canCloseRight} onClick={run(onCloseRight)}>Close tabs to the right</button>
      <div className="tab-menu-sep" role="separator" />
      <button className="tab-menu-item" role="menuitem" onClick={run(onTogglePin)}>{pinned ? "Unpin tab" : "Pin tab"}</button>
      <button className="tab-menu-item" role="menuitem" onClick={run(onDuplicate)}>Duplicate tab</button>
      <div className="tab-menu-sep" role="separator" />
      <button className="tab-menu-item" role="menuitem" disabled={!canReopen} onClick={run(onReopenClosed)}>Reopen closed tab</button>
    </div>
  );
}

/** The ⌄ list: every open tab, searchable. */
function TabList({ tabs, activeId, anchor, onDismiss, onPick }: {
  tabs: TabBarItem[]; activeId: string; anchor: HTMLElement | null; onDismiss(): void; onPick(id: string): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const rows = useMemo(() => rankByFuzzy(tabs, query, (t) => t.fullTitle).map((r) => r.item), [tabs, query]);
  const pos = useMemo(() => {
    const r = anchor?.getBoundingClientRect();
    return r ? { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) } : { top: 40, right: 8 };
  }, [anchor]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !anchor?.contains(t)) onDismiss();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onDismiss, anchor]);
  useEffect(() => { setHi(0); }, [query]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const t = rows[hi]; if (t) onPick(t.id); }
  };

  return (
    <div ref={ref} className="tab-list" style={{ top: pos.top, right: pos.right }} data-testid="tab-list">
      <input
        className="tab-list-search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search open tabs…"
        aria-label="Search open tabs"
        role="combobox"
        aria-expanded="true"
        aria-controls="tab-list-rows"
      />
      <div id="tab-list-rows" className="tab-list-rows" role="listbox" aria-label="Open tabs">
        {rows.length === 0 && <div className="tab-list-empty">No open tab matches</div>}
        {rows.map((t, i) => (
          <button
            key={t.id}
            className={`tab-list-row${i === hi ? " tab-list-hi" : ""}${t.id === activeId ? " tab-list-current" : ""}`}
            role="option"
            aria-selected={t.id === activeId}
            onMouseEnter={() => setHi(i)}
            onClick={() => onPick(t.id)}
            data-testid="tab-list-row"
          >
            <Icon name={t.icon} size={14} />
            <span className="tab-list-title">{t.fullTitle}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
