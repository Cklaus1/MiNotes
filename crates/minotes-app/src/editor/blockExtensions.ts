/**
 * The TipTap extension set of a block editor. Shared by the live editor
 * (useBlockEditor) and the static renderer (staticRender.ts), so a block that is
 * not being edited renders exactly the DOM its editor would.
 */
import StarterKit from "@tiptap/starter-kit";
import { HardBreak } from "@tiptap/extension-hard-break";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import Typography from "@tiptap/extension-typography";
import Placeholder from "@tiptap/extension-placeholder";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { mergeAttributes } from "@tiptap/core";
import { codeLanguageLabel } from "./codeLanguage";
import { TableRow } from "@tiptap/extension-table-row";
import { MarkdownTable, AlignedTableCell, AlignedTableHeader } from "./tables";
import Image from "@tiptap/extension-image";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";
import { WikiLinkNode } from "./WikiLinkNode";
import { BlockRefNode } from "./BlockRefNode";
import { TagNode } from "./TagNode";
import { SlashCommands } from "./slashCommands";
import { PageLinkSuggestion } from "./PageLinkSuggestion";
import { BlockRefSuggestion } from "./BlockRefSuggestion";
import { TaskListInputRule } from "./taskListInputRule";
// ── Import / attachments ──
import { displaySrc } from "../lib/attachments";
// ── End import ──
import { isRemoteSrc, remoteHost } from "../lib/remoteImages";

const lowlight = createLowlight(common);

/**
 * A line break inside a block is stored as a plain "\n" (blocks are line-oriented:
 * "Line1\nLine2"). Parsing uses `breaks: true` so that newline becomes a hardBreak
 * instead of collapsing to a space; this serializer writes it back as "\n"
 * (tiptap-markdown's default is CommonMark's backslash-newline), so an edited
 * multi-line block round-trips byte-for-byte.
 */
const LineBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any, parent: any, index: number) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              // A pipe-table row is one line: a break inside a cell becomes a space
              // (`<br>` would come back as literal text, since html is off).
              state.write(state.inTable ? " " : "\n");
              return;
            }
          }
        },
        parse: {},
      },
    };
  },
});

export interface BlockExtensionCallbacks {
  onPageLinkClick: (title: string, shiftKey?: boolean) => void;
  onBlockRefClick: (blockId: string) => void;
  onTagClick: (tag: string) => void;
}

export function createBlockExtensions(cb: BlockExtensionCallbacks) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      // `[name](attachment:<hash>/<name>)` links to stored files (see lib/attachments).
      link: { protocols: ["attachment"] },
      codeBlock: false, // replaced by CodeBlockLowlight
      hardBreak: false, // replaced by LineBreak (plain-newline markdown)
    }),
    LineBreak,
    // Adds data-language-label ("JavaScript") to <pre> for the CSS label; without
    // it the label was the raw class name ("language-js").
    CodeBlockLowlight.extend({
      renderHTML({ node, HTMLAttributes }) {
        const language: string | null = node.attrs.language || null;
        const label = codeLanguageLabel(language);
        return [
          "pre",
          mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, label ? { "data-language-label": label } : {}),
          ["code", { class: language ? this.options.languageClassPrefix + language : null }, 0],
        ];
      },
    }).configure({ lowlight }),
    MarkdownTable.configure({ resizable: true }),
    TableRow,
    AlignedTableCell,
    AlignedTableHeader,
    TaskList.extend({
      parseHTML() {
        return [
          { tag: 'ul[data-type="taskList"]', priority: 51 },
          { tag: 'ul.contains-task-list', priority: 51 },
        ];
      },
    }),
    TaskItem.extend({
      parseHTML() {
        return [
          { tag: `li[data-type="taskItem"]`, priority: 52 },
          {
            tag: 'li.task-list-item',
            priority: 52,
            getAttrs: (el: HTMLElement) => {
              const checkbox = el.querySelector('input[type="checkbox"]');
              return { checked: checkbox ? (checkbox as HTMLInputElement).checked : false };
            },
          },
        ];
      },
    }).configure({ nested: true }),
    Highlight,
    // ── Import / attachments: `attachment:<hash>/<name>` srcs are served by the
    // attachment protocol; the stored markdown keeps the reference. ──
    Image.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          src: {
            default: null,
            parseHTML: (el: HTMLElement) =>
              el.getAttribute("data-attachment-src") || el.getAttribute("data-remote-src") || el.getAttribute("src"),
            renderHTML: (attrs: { src?: string | null }) => {
              const src = attrs.src ?? "";
              return src.startsWith("attachment:")
                ? { src: displaySrc(src), "data-attachment-src": src }
                : { src };
            },
          },
        };
      },
      // ── Remote images (lib/remoteImages.ts): a web address never becomes an
      // <img src>; it renders as a placeholder that remoteImages fills with a
      // backend-fetched blob: image once remote images are allowed. ──
      parseHTML() {
        return [
          ...(this.parent?.() ?? []),
          {
            tag: "span.remote-img[data-remote-src]",
            getAttrs: (el: HTMLElement) => ({ alt: el.getAttribute("data-alt"), title: el.getAttribute("data-title") }),
          },
        ];
      },
      renderHTML({ node, HTMLAttributes }) {
        const src: string = node.attrs.src ?? "";
        if (!isRemoteSrc(src)) return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
        const alt: string = node.attrs.alt ?? "";
        return [
          "span",
          {
            class: "remote-img",
            "data-remote-src": src,
            "data-alt": alt,
            "data-title": node.attrs.title ?? "",
            contenteditable: "false",
          },
          ["span", { class: "remote-img-label" },
            ["span", { class: "remote-img-alt" }, alt || "Image"],
            ["span", { class: "remote-img-host" }, remoteHost(src)]],
        ];
      },
    }).configure({ inline: false, allowBase64: true }),
    Typography,
    Placeholder.configure({
      placeholder: ({ editor }) => editor.isFocused ? "Type '/' for commands" : "",
      showOnlyWhenEditable: true,
      showOnlyCurrent: true,
    }),
    Markdown.configure({
      html: false,
      breaks: true,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    WikiLinkNode.configure({ onPageLinkClick: cb.onPageLinkClick }),
    BlockRefNode.configure({ onBlockRefClick: cb.onBlockRefClick }),
    TagNode.configure({ onTagClick: cb.onTagClick }),
    TaskListInputRule,
    SlashCommands,
    PageLinkSuggestion,
    BlockRefSuggestion,
  ];
}
