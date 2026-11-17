import type { IconName } from "./icons";

/** One tab as the tab row (components/TabBar.tsx) draws it. */
export interface TabBarItem {
  id: string;
  pinned: boolean;
  icon: IconName;
  /** Shown in the tab (the row ellipsizes it). */
  title: string;
  /** Tooltip, the pinned tab's accessible name, and the ⌄ list's text. */
  fullTitle: string;
}
