/**
 * Every keyboard shortcut, grouped by where it works — shown in Settings and
 * in the Ctrl+/ overlay (components/ShortcutsOverlay.tsx, also "Keyboard
 * shortcuts" in the palette). Keep in sync with App.tsx and the views' handlers.
 */
// Every shortcut listed here was pressed in the real app and does what it says.
export const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "Anywhere (also while editing a block)",
    items: [
      ["Ctrl+K", "Search (Tab: pages / blocks / journals); type > for commands"],
      ["Ctrl+[ / Ctrl+]", "Back / forward in this tab (pages, views, notebooks); also the mouse's back / forward buttons"],
      ["Ctrl+J", "Today's journal"],
      ["Alt+↑ / Alt+↓", "Previous / next journal day"],
      ["Ctrl+N", "New page"],
      ["Ctrl+1 … Ctrl+7", "Open pinned page 1–7"],
      ["Ctrl+G", "Graph view"],
      ["Ctrl+M", "Mind map"],
      ["Ctrl+Shift+K", "Kanban board"],
      ["Ctrl+Shift+W", "New whiteboard (Draw)"],
      ["Ctrl+Q", "SQL query panel"],
      ["Ctrl+R", "Flashcard review"],
      ["Ctrl+P", "Open a PDF by path"],
      ["Ctrl+Shift+C", "Copy the page as text"],
      ["Ctrl+Shift+T", "Toggle light/dark theme"],
      ["Ctrl+Shift+L", "Lock an encrypted notebook"],
      ["Ctrl+Shift+A", "Ask AI about your notes"],
      ["Ctrl+Shift+I", "Import from Obsidian, Evernote or markdown"],
      ["Ctrl+,", "Settings"],
      ["Ctrl+Shift+\\", "Show/hide the left sidebar"],
      ["Ctrl+\\", "Show/hide the right sidebar"],
      ["Ctrl+/", "This list of shortcuts"],
      ["Esc", "Close the open panel, menu or view"],
    ],
  },
  {
    title: "Tabs",
    items: [
      ["Ctrl+T", "New tab (Settings → Editor chooses what it opens)"],
      ["Ctrl+W", "Close the tab (not the last one)"],
      ["Ctrl+Tab / Ctrl+Shift+Tab", "Next / previous tab (also Ctrl+PgDn / Ctrl+PgUp)"],
      ["Alt+1 … Alt+8", "Go to tab 1–8; Alt+9: the last tab"],
      ["Ctrl+Shift+PgUp / PgDn", "Move the tab left / right"],
      ["Ctrl+click, middle-click", "Open a page, link or view in a background tab"],
      ["Ctrl+Shift+click", "Open in a new tab and switch to it"],
      ["Ctrl+Enter (search)", "Open the result in a new tab"],
    ],
  },
  {
    title: "Page (no block being edited)",
    items: [
      ["Ctrl+Z", "Undo (also restores a page you just deleted)"],
      ["Ctrl+Shift+Z", "Redo"],
      ["Ctrl+A", "Select all blocks"],
      ["Shift+click", "Extend the block selection"],
      ["Del / Backspace", "Delete the selected blocks"],
    ],
  },
  {
    title: "While editing a block",
    items: [
      ["Enter", "New block (split at the caret)"],
      ["Tab", "Indent under the block above"],
      ["Shift+Tab", "Outdent one level"],
      ["Enter on an empty line", "Nested: outdent one level (top level: stays)"],
      ["Backspace at the start", "Nested: outdent one level; top level: merge into the block above"],
      ["Esc", "Stop editing (the block stays selected; Tab / Shift+Tab move it)"],
      ["Ctrl+Enter", "Cycle TODO → DOING → DONE"],
      ["Ctrl+B / Ctrl+I / Ctrl+E", "Bold / italic / inline code"],
      ["Ctrl+Z", "Undo typing"],
      ["/", "Insert menu (headings, todo, table, whiteboard…)"],
      ["[[", "Link to a page"],
      ["Alt+→ / Alt+←", "Zoom into the block / back out"],
    ],
  },
  {
    title: "All Pages, Trash and Archive",
    items: [
      ["↑ / ↓", "Move between rows"],
      ["Space", "Tick the row (Shift+↑/↓, Shift+click: a range)"],
      ["Ctrl+A", "Tick every row"],
      ["Enter", "Open the page (All Pages)"],
      ["Del", "Move to Trash (All Pages) / delete permanently (Trash)"],
    ],
  },
  {
    title: "Whiteboard",
    items: [
      ["S / D / T / A / B", "Select / draw / text / arrow / box tool"],
      ["F", "Fit everything in view"],
      ["Arrows", "Move the selected item (Shift: 10 px)"],
      ["Enter", "Edit the selected note or text"],
      ["Esc", "Back to Select, then close"],
    ],
  },
  {
    title: "Kanban",
    items: [
      ["Ctrl+F or /", "Filter cards"],
      ["Arrows", "Move between cards and columns"],
      ["N", "New card in the focused card's column"],
    ],
  },
  {
    title: "Mind map",
    items: [
      ["Arrows", "Move between nodes"],
      ["Tab / Enter", "Add a child / a sibling"],
      ["Del", "Delete the node"],
      ["Hold M", "Show the minimap"],
    ],
  },
  {
    title: "Flashcard review",
    items: [
      ["Space / Enter", "Show the answer"],
      ["1 / 2 / 3 / 4", "Again / hard / good / easy"],
    ],
  },
];

/** Window event that opens the shortcut overlay (Ctrl+/, the palette). */
export const OPEN_SHORTCUTS_EVENT = "minotes:open-shortcuts";
