/**
 * Exposes a few source modules on window.__MINOTES__.modules, keyed by their dev
 * server path. Browser-mode journey tests do `await import('/src/lib/api.ts')`
 * against the Vite dev server; the built desktop app has no dev server, so the
 * desktop-check harness resolves those same imports from here instead. That lets
 * one journey suite run against both the mock backend and the real one.
 *
 * mockBackend is included only so the harness can replay its demo seed into a
 * real database — api.ts never routes to it inside Tauri.
 */
import * as api from "./api";
import * as settings from "./settings";
import * as todoExtractor from "./todoExtractor";
import * as whiteboardUtils from "./whiteboardUtils";
import * as mockBackend from "./mockBackend";
import * as undoStack from "./undoStack";
import * as undoManager from "./undoManager";
import * as pendingEdits from "./pendingEdits";
import { registerTestApi } from "./testApi";

registerTestApi({
  modules: {
    "/src/lib/api.ts": api,
    "/src/lib/settings.ts": settings,
    "/src/lib/todoExtractor.ts": todoExtractor,
    "/src/lib/whiteboardUtils.ts": whiteboardUtils,
    "/src/lib/mockBackend.ts": mockBackend,
    "/src/lib/undoStack.ts": undoStack,
    "/src/lib/undoManager.ts": undoManager,
    "/src/lib/pendingEdits.ts": pendingEdits,
  },
} as any);
