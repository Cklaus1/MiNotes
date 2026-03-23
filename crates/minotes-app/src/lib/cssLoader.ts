import * as api from './api';

const STYLE_ELEMENT_ID = 'minotes-custom-css';

export async function loadEnabledSnippets(): Promise<void> {
  const snippets = await api.getEnabledCssSnippets();

  // Remove existing injected styles
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing) existing.remove();

  if (snippets.length === 0) return;

  // Combine all enabled snippet CSS
  const combinedCss = snippets.map(s => `/* ${s.name} (${s.source}) */\n${s.css}`).join('\n\n');

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = combinedCss;
  document.head.appendChild(style);
}

export async function reloadSnippets(): Promise<void> {
  await loadEnabledSnippets();
}
