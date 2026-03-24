// Whiteboard utility functions — separated from Whiteboard.tsx component
// to avoid breaking Vite React Fast Refresh (components-only exports rule)

const STORAGE_PREFIX = "minotes-whiteboard-";

/** Whiteboard content marker pattern */
export const WHITEBOARD_REGEX = /^\{\{whiteboard:([a-zA-Z0-9-]+)\}\}$/;

/** Check if a whiteboard has saved data */
export function hasWhiteboardData(whiteboardId: string): boolean {
  return localStorage.getItem(STORAGE_PREFIX + whiteboardId) !== null;
}

/** Generate a new whiteboard ID */
export function generateWhiteboardId(): string {
  return "wb-" + crypto.randomUUID().slice(0, 8);
}
