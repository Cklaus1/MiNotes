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
  /** "notebook": inserts `[[Name::`; "xpage": a page in notebook `notebook`. */
  kind?: "notebook" | "xpage";
  notebook?: string;
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
    const sep = query.indexOf("::");
    return (
      <div className="slash-menu">
        <div className="slash-menu-empty">
          {sep >= 0
            ? `No such page in ${query.slice(0, sep).trim() || "that notebook"}. Enter links to it anyway (nothing is created).`
            : `No pages found. Press Enter to create "${query}".`}
        </div>
      </div>
    );
  }

  return (
    <div className="slash-menu">
      {items.map((item, index) => (
        <button
          key={item.id}
          data-kind={item.kind ?? "page"}
          className={`slash-menu-item ${index === selectedIndex ? "active" : ""}`}
          onClick={() => selectItem(index)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          {item.kind === "notebook" ? (
            <>
              <span className="slash-menu-item-title">{item.title}::</span>
              <span className="slash-menu-item-hint">notebook</span>
            </>
          ) : item.kind === "xpage" ? (
            <span className="slash-menu-item-title"><span className="xnb-badge">{item.notebook}</span> {item.title}</span>
          ) : (
            <span className="slash-menu-item-title">{item.title}</span>
          )}
        </button>
      ))}
    </div>
  );
});

PageLinkMenu.displayName = "PageLinkMenu";
