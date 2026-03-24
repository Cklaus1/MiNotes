import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useCallback,
} from "react";

interface PageItem {
  id: string;
  title: string;
}

interface PageLinkMenuProps {
  items: PageItem[];
  command: (item: PageItem) => void;
  query: string;
}

export const PageLinkMenu = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  PageLinkMenuProps
>(({ items, command, query }, ref) => {
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
        if (items[selectedIndex]) {
          selectItem(selectedIndex);
        } else if (query) {
          // No match — will create new page via command
          command({ id: "", title: query });
        }
        return true;
      }
      if (event.key === "Tab") {
        if (items[0]) {
          selectItem(0);
        }
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-menu-empty">
          No pages found. Press Enter to create "{query}".
        </div>
      </div>
    );
  }

  return (
    <div className="slash-menu">
      {items.map((item, index) => (
        <button
          key={item.id}
          className={`slash-menu-item ${index === selectedIndex ? "active" : ""}`}
          onClick={() => selectItem(index)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <span className="slash-menu-item-title">{item.title}</span>
        </button>
      ))}
    </div>
  );
});

PageLinkMenu.displayName = "PageLinkMenu";
