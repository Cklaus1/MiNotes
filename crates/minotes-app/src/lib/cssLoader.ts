import * as api from './api';

const STYLE_ELEMENT_ID = 'minotes-custom-css';

// Bug #34: sanitize snippet CSS before injection. User CSS is injected verbatim into a
// <style> tag, so an `@import` or external `url(...)` can phone home (exfiltrating that
// the app is open / which page is viewed) or load tracking pixels. Strip remote
// references while leaving local styling intact. This is a conservative filter, not a
// full CSS parser — it removes the high-risk exfiltration vectors.
export function sanitizeSnippetCss(css: string): string {
  return css
    // Drop @import rules entirely (they fetch remote stylesheets).
    .replace(/@import[^;]*;?/gi, '/* @import removed */')
    // Neutralize url() that points to a remote origin (http:, https:, //, protocol-relative).
    .replace(/url\(\s*(['"]?)\s*(https?:|\/\/)[^)]*\1\s*\)/gi, 'none /* remote url removed */');
}

export async function loadEnabledSnippets(): Promise<void> {
  const snippets = await api.getEnabledCssSnippets();

  // Remove existing injected styles
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing) existing.remove();

  if (snippets.length === 0) return;

  // Combine all enabled snippet CSS (sanitized — Bug #34).
  const combinedCss = snippets.map(s => `/* ${s.name} (${s.source}) */\n${sanitizeSnippetCss(s.css)}`).join('\n\n');

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = combinedCss;
  document.head.appendChild(style);
}

export async function reloadSnippets(): Promise<void> {
  await loadEnabledSnippets();
}
