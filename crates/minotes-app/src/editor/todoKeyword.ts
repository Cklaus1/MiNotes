/**
 * The TODO / DOING / DONE keyword at the start of a block is covered by a
 * coloured badge (BlockItem). This decoration wraps the keyword in
 * `span.todo-kw` so CSS can leave room between the badge and the text after it
 * (the badge used to touch it). Decorations are rendered by the static renderer
 * too, so static and live blocks look the same. Nothing is stored.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const KEYWORD = /^(TODO|DOING|DONE) /;

export const TodoKeyword = Extension.create({
  name: "todoKeyword",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("todoKeyword"),
        props: {
          decorations(state) {
            const first = state.doc.firstChild;
            if (!first || !first.isTextblock) return null;
            const m = KEYWORD.exec(first.textContent);
            if (!m) return null;
            // The keyword is the first characters of the first textblock (pos 1).
            const decos = [Decoration.inline(1, 1 + m[1].length, { class: `todo-kw todo-kw-${m[1].toLowerCase()}` })];
            if (m[1] === "DONE") {
              // The task text is struck through — not the keyword under the badge
              // or the gap after it.
              const restFrom = 1 + m[0].length;
              const firstEnd = 1 + first.content.size;
              if (firstEnd > restFrom) decos.push(Decoration.inline(restFrom, firstEnd, { class: "todo-done-text" }));
              state.doc.forEach((node, offset, index) => {
                if (index > 0) decos.push(Decoration.node(offset, offset + node.nodeSize, { class: "todo-done-text" }));
              });
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
