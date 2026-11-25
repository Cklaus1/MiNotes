import { Extension, InputRule } from "@tiptap/core";

/**
 * Markdown task syntax typed as `- [ ] task` / `* [x] task`.
 *
 * Typing `- ` first turns the line into a bullet list, so the `[ ] ` that follows
 * lands inside a bullet item, where TaskItem's own rule (`[ ] ` at the start of a
 * plain paragraph) can't wrap it — the result was a bullet with a literal,
 * escaped `\[ \]`. This rule converts that bullet item into a task item instead.
 * `[ ]`, `[]` and `[x]` are accepted (x in either case → checked).
 */
export const TaskListInputRule = Extension.create({
  name: "taskListInputRule",
  // Run before TaskItem's wrapping rule (which matches the same text but can't apply here).
  priority: 1000,

  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        handler: ({ state, range, match, chain }) => {
          const $from = state.doc.resolve(range.from);
          // Only inside the first paragraph of a bullet-list item.
          if ($from.depth < 3) return null;
          const item = $from.node($from.depth - 1);
          const list = $from.node($from.depth - 2);
          if (item.type.name !== "listItem" || list.type.name !== "bulletList") return null;
          if ($from.index($from.depth - 1) !== 0) return null;
          if (!state.schema.nodes.taskList || !state.schema.nodes.taskItem) return null;
          const checked = (match[1] ?? "").toLowerCase() === "x";
          chain()
            .deleteRange(range)
            .toggleTaskList()
            .updateAttributes("taskItem", { checked })
            .run();
        },
      }),
    ];
  },
});
