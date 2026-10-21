import { defineConfig } from "vitest/config";

// Unit tests (`npm test`): the editor's markdown round trip, the app-wide confirm
// dialog, paste handling and source lints. jsdom gives TipTap/ProseMirror a DOM.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
