import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const STYLESHEETS = "virtual:stylesheets";

// Unit tests (`npm test`): the editor's markdown round trip, the app-wide confirm
// dialog, paste handling and source lints. jsdom gives TipTap/ProseMirror a DOM.
export default defineConfig({
  plugins: [
    {
      // Vitest empties every CSS import (even `?raw`); this module gives the CSS
      // lints (lib/cssTokens.test.ts) each stylesheet's real text, by path.
      name: "stylesheet-text-for-lints",
      resolveId: (id) => (id === STYLESHEETS ? "\0" + STYLESHEETS : undefined),
      load(id) {
        if (id !== "\0" + STYLESHEETS) return;
        const src = join(__dirname, "src");
        const files = (readdirSync(src, { recursive: true }) as string[]).filter((p) => p.endsWith(".css"));
        const text = Object.fromEntries(files.map((p) => ["/src/" + p, readFileSync(join(src, p), "utf8")]));
        return `export default ${JSON.stringify(text)};`;
      },
    },
  ],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
