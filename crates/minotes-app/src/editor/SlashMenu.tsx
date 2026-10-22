import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import type { Editor } from "@tiptap/react";
import type { Range } from "@tiptap/core";
import Icon from "../components/Icon";
import type { IconName } from "../lib/icons";

export type SlashGroup = "Basic" | "Lists" | "Media" | "Links & dates" | "Advanced" | "Templates";

export interface SlashMenuItem {
  title: string;
  /** One line saying what the command does (shown under the title). */
  description: string;
  /** Exact short names (`/h2`, `/hr`, `/ol`…) that match this command first. */
  aliases?: string[];
  /** More words that find it (`/checkbox` → Todo List); never shown. */
  keywords?: string[];
  icon?: IconName;
  group?: SlashGroup;
  command: (props: { editor: Editor; range: Range }) => void;
}

interface SlashMenuProps {
  items: SlashMenuItem[];
  query?: string;
  command: (item: SlashMenuItem) => void;
}

/**
 * The `/` menu: icon, title and a one-line description per command. With no
 * query the commands are listed under their group; while typing, best match
 * first (editor/slashCommands.ts). ↑/↓ (wrapping), Home/End, PageUp/PageDown
 * (a group at a time), Enter or Tab to run, Esc to close.
 */
export const SlashMenu = forwardRef<{ onKeyDown: (props: { event: KeyboardEvent }) => boolean }, SlashMenuProps>(
  ({ items, query, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    // Keep the highlighted command in view while moving with the keyboard.
    useLayoutEffect(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
      el?.scrollIntoView?.({ block: "nearest" });
    }, [selectedIndex]);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];
        if (item) {
          command(item);
        }
      },
      [items, command]
    );

    const grouped = !query?.trim() && items.some((i) => i.group);

    /** First index of the next (+1) / previous (-1) group from `from`. */
    const groupJump = (from: number, dir: 1 | -1): number => {
      const g = items[from]?.group;
      if (dir === 1) {
        for (let i = from + 1; i < items.length; i++) if (items[i].group !== g) return i;
        return items.length - 1;
      }
      // Start of this group; if already there, start of the previous one.
      let start = from;
      while (start > 0 && items[start - 1].group === g) start--;
      if (start < from) return start;
      if (start === 0) return 0;
      const pg = items[start - 1].group;
      let p = start - 1;
      while (p > 0 && items[p - 1].group === pg) p--;
      return p;
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowUp") {
          setSelectedIndex((prev) => (prev + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((prev) => (prev + 1) % items.length);
          return true;
        }
        if (event.key === "Home") { setSelectedIndex(0); return true; }
        if (event.key === "End") { setSelectedIndex(items.length - 1); return true; }
        if (event.key === "PageDown") { setSelectedIndex((prev) => groupJump(prev, 1)); return true; }
        if (event.key === "PageUp") { setSelectedIndex((prev) => groupJump(prev, -1)); return true; }
        if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="slash-menu" role="listbox" aria-label="Commands">
          <div className="slash-menu-empty">No results</div>
        </div>
      );
    }

    return (
      <div className="slash-menu" role="listbox" aria-label="Commands" ref={listRef}>
        {items.map((item, index) => (
          <div key={`${item.group ?? ""}:${item.title}`} className="slash-menu-row">
            {grouped && item.group && item.group !== items[index - 1]?.group && (
              <div className="slash-menu-group" role="presentation">{item.group}</div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              data-index={index}
              data-title={item.title}
              className={`slash-menu-item ${index === selectedIndex ? "active" : ""}`}
              onMouseDown={(e) => e.preventDefault() /* keep the editor's caret */}
              onClick={() => selectItem(index)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="slash-menu-item-icon" aria-hidden="true">
                <Icon name={item.icon ?? "page"} size={16} />
              </span>
              <span className="slash-menu-item-text">
                <span className="slash-menu-item-title">{item.title}</span>
                <span className="slash-menu-item-description">{item.description}</span>
              </span>
            </button>
          </div>
        ))}
      </div>
    );
  }
);

SlashMenu.displayName = "SlashMenu";
