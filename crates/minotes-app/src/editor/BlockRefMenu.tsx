import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useCallback,
} from "react";

interface BlockRefItem {
  id: string;
  content: string;
  pageTitle?: string;
}

interface BlockRefMenuProps {
  items: BlockRefItem[];
  command: (item: BlockRefItem) => void;
  query: string;
}

export const BlockRefMenu = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  BlockRefMenuProps
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
          {query ? "No blocks found." : "Type to search blocks..."}
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
          <span className="slash-menu-item-title">
            {item.content.length > 60
              ? item.content.slice(0, 60) + "..."
              : item.content || "(empty block)"}
          </span>
          {item.pageTitle && (
            <span className="slash-menu-item-description">
              {item.pageTitle}
            </span>
          )}
        </button>
      ))}
    </div>
  );
});

BlockRefMenu.displayName = "BlockRefMenu";
