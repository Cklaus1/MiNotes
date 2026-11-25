/**
 * CodeMirror 6 block editor — "Obsidian mode" source editor.
 * Only loaded when obsidianEditorEnabled is true in settings.
 * Shows raw markdown source with syntax highlighting.
 */
import { useRef, useEffect, useCallback } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { autocompletion } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";

interface Props {
  content: string;
  onSave: (content: string) => void;
}

// Catppuccin Mocha theme for CM6
const catppuccinTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    fontSize: "14px",
    lineHeight: "1.6",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--accent)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "rgba(137, 180, 250, 0.3) !important",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(49, 50, 68, 0.5)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(49, 50, 68, 0.5)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--bg-surface)",
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
  },
});

export default function CM6BlockEditor({ content, onSave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  contentRef.current = content;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        bracketMatching(),
        history(),
        highlightSelectionMatches(),
        autocompletion(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        catppuccinTheme,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          {
            key: "Escape",
            run: (view) => {
              view.contentDOM.blur();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.focusChanged && !update.view.hasFocus) {
            // Blur → save
            const newContent = update.state.doc.toString();
            if (newContent.trim() !== contentRef.current.trim()) {
              onSaveRef.current(newContent.trim());
            }
          }
        }),
        EditorView.domEventHandlers({
          // Allow CM6 plugins to register their own handlers here
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // Only create once

  // Sync external content changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (content.trim() !== current.trim()) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: content },
      });
    }
  }, [content]);

  return <div ref={containerRef} className="cm6-editor" />;
}
