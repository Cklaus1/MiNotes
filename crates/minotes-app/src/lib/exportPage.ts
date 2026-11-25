import type { PageTree } from "./api";
import { exportFileName, saveExport } from "./exportFile";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function mdToHtml(md: string): string {
  // Note text is data: escape it before the markdown → HTML rewrites.
  let html = escapeHtml(md);
  // Headings
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  // Bold/italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");
  // Inline code
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  // Wiki links
  html = html.replace(/\[\[(.+?)\]\]/g, '<span style="color:#89b4fa">$1</span>');
  // Task lists
  html = html.replace(/^- \[x\] (.+)$/gm, '<li style="list-style:none"><input type="checkbox" checked disabled> <del>$1</del></li>');
  html = html.replace(/^- \[ \] (.+)$/gm, '<li style="list-style:none"><input type="checkbox" disabled> $1</li>');
  // Lists
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  // HR
  html = html.replace(/^---$/gm, "<hr>");
  // TODO/DOING/DONE badges
  html = html.replace(/^(TODO|DOING|DONE) /gm, '<span style="background:rgba(137,180,250,0.15);color:#89b4fa;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:700">$1</span> ');
  // Paragraphs (lines that aren't already wrapped)
  html = html.replace(/^(?!<[hluod]|<li|<hr|<span)(.*\S.*)$/gm, "<p>$1</p>");
  return html;
}

export function exportAsHtml(pageTree: PageTree): string {
  const { page, blocks } = pageTree;
  // Blocks come in outline order; positions are per parent, so never sort by them.
  const title = escapeHtml(page.title);
  let body = `<h1>${title}</h1>\n`;
  for (const block of blocks) {
    if (!block.content.trim()) continue;
    body += mdToHtml(block.content) + "\n";
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #cdd6f4; background: #1e1e2e; line-height: 1.6; }
  h1 { font-size: 2em; border-bottom: 1px solid #45475a; padding-bottom: 8px; }
  h2 { font-size: 1.5em; margin-top: 24px; }
  h3 { font-size: 1.2em; }
  code { background: #313244; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  hr { border: none; border-top: 1px solid #45475a; margin: 16px 0; }
  li { margin: 4px 0; }
  del { color: #6c7086; }
  strong { font-weight: 700; }
  @media print { body { color: #1e1e2e; background: white; } code { background: #f0f0f0; } hr { border-color: #ccc; } }
</style>
</head>
<body>
${body}
<footer style="margin-top:40px;padding-top:16px;border-top:1px solid #45475a;font-size:12px;color:#6c7086">
  Exported from MiNotes
</footer>
</body>
</html>`;
}

/** "↗ Export" in page info: the save dialog on desktop, a download in the browser. */
export function downloadHtml(pageTree: PageTree): Promise<unknown> {
  const html = exportAsHtml(pageTree);
  return saveExport(exportFileName(pageTree.page.title, "html", "page"), html, "Page", "text/html");
}

export function printPage(): void {
  window.print();
}
