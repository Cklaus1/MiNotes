import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useCallback,
} from "react";
import type { Editor } from "@tiptap/react";
import type { Range } from "@tiptap/core";

export interface SlashMenuItem {
  title: string;
  description: string;
  command: (props: { editor: Editor; range: Range }) => void;
}

interface SlashMenuProps {
  items: SlashMenuItem[];
  command: (item: SlashMenuItem) => void;
}

export const SlashMenu = forwardRef<{ onKeyDown: (props: { event: KeyboardEvent }) => boolean }, SlashMenuProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];
        if (item) {
          command(item);
        }
      },
      [items, command]
    );

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === "ArrowUp") {
          setSelectedIndex((prev) => (prev + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((prev) => (prev + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="slash-menu">
          <div className="slash-menu-empty">No results</div>
        </div>
      );
    }

    return (
      <div className="slash-menu">
        {items.map((item, index) => (
          <button
            key={item.title}
            className={`slash-menu-item ${index === selectedIndex ? "active" : ""}`}
            onClick={() => selectItem(index)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <span className="slash-menu-item-title">{item.title}</span>
            <span className="slash-menu-item-description">{item.description}</span>
          </button>
        ))}
      </div>
    );
  }
);

SlashMenu.displayName = "SlashMenu";
