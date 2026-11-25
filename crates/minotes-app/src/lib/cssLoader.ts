import * as api from './api';

const STYLE_ELEMENT_ID = 'minotes-custom-css';

// Bug #34 / security: sanitize snippet CSS before injection. User CSS is injected into a
// <style> tag, so an `@import`, `url(...)` or `image-set(...)` can phone home
// (exfiltrating that the app is open / which page is viewed, or attribute values via
// selector-driven background fetches). The Tauri CSP (tauri.conf.json) is the primary
// defense; this filter is defense in depth and keeps the browser dev build honest.
//
// It is not a full CSS parser. It works in three steps so escape tricks cannot hide
// keywords from the matchers:
//   1. drop comments (`ur/**/l(` cannot be split around a comment),
//   2. normalize CSS escapes (`u\72l(` -> `url(`, `@\69mport` -> `@import`,
//      `ht\74tps` -> `https`). Decoded characters that could carry syntax (quotes,
//      parens, `;`, `\` …) are re-emitted escaped, so they stay inert and legit escapes
//      like `content: "\f101"` / `"\""` keep their meaning,
//   3. strip @import rules, url() (except data: and #fragment), image-set(), src(),
//      and quoted strings that contain a remote URL. Repeated until nothing changes.
// What is emitted is exactly the normalized text that was checked.
//
// Examples (verified with a node one-liner, see PR notes):
//   '@\69mport "https://x/a.css";'           -> '/* import rule removed */'
//   'a{background:u\72l(https://x/p.png)}'   -> 'a{background:none}'
//   'a{background:url(ht\74tps://x/p.png)}'  -> 'a{background:none}'
//   'a{background:image-set("https://x" 1x)}'-> 'a{background:none}'
//   'a{background:url(data:image/png;base64,AA)}' -> unchanged
//   '.i::before{content:"\f101"}'            -> same glyph, emitted as the literal U+F101 char
export function sanitizeSnippetCss(css: string): string {
  let out = normalizeCssEscapes(css.replace(/\/\*[\s\S]*?(\*\/|$)/g, ''));
  for (let i = 0; i < 5; i++) {
    const next = stripRemoteRefs(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

const SAFE_LITERAL = /[A-Za-z0-9_\-\s]/;

function normalizeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_m, hex: string | undefined, nl: string | undefined, ch: string | undefined) => {
      if (nl !== undefined) return ''; // escaped newline = line continuation in strings
      let c: string;
      if (hex !== undefined) {
        const cp = parseInt(hex, 16);
        c = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
          ? '�'
          : String.fromCodePoint(cp);
      } else {
        c = ch as string;
      }
      const code = c.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f) return `\\${code.toString(16)} `;
      if (code > 0x7f) return c; // non-ASCII (icon-font code points etc.) is inert
      if (/[A-Za-z0-9_-]/.test(c)) return c; // decoded letters are what we must see
      if (SAFE_LITERAL.test(c)) return `\\${code.toString(16)} `; // whitespace
      return `\\${c}`; // punctuation stays escaped => no syntactic meaning
    });
}

const REMOTE = /(?:[a-z][a-z0-9+.-]*:)?\/\//i;

function stripRemoteRefs(css: string): string {
  return css
    // @import rules (to the next `;` or end of input).
    .replace(/@import\b[^;]*;?/gi, '/* import rule removed */')
    // url(...) — allow only inline data: and same-document #fragment references. An
    // unterminated url( swallows the rest of the input (that is how CSS parses it).
    .replace(/\burl\(\s*("[^"]*"|'[^']*'|[^)]*?)\s*(?:\)|$)/gi, (m, arg: string) => {
      const v = arg.replace(/^["']|["']$/g, '').trim();
      return /^(data:|#)/i.test(v) && m.endsWith(')') ? m : 'none';
    })
    // Functions that fetch resources without url(): image-set / -webkit-image-set / src().
    .replace(/(?:-webkit-)?image-set\(\s*(?:"[^"]*"|'[^']*'|[^)])*(?:\)|$)/gi, 'none')
    .replace(/\bsrc\(\s*(?:"[^"]*"|'[^']*'|[^)])*(?:\)|$)/gi, 'none')
    // Quoted strings that still carry a remote URL (e.g. `@font-face{src:"//x"}`).
    .replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/g, (s) => (REMOTE.test(s) ? '""' : s));
}

export async function loadEnabledSnippets(): Promise<void> {
  const snippets = await api.getEnabledCssSnippets();

  // Remove existing injected styles
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing) existing.remove();

  if (snippets.length === 0) return;

  // Combine all enabled snippet CSS (sanitized — Bug #34). Names are sanitized too so a
  // `*/` in a snippet name cannot close the label comment and inject rules.
  const combinedCss = snippets
    .map(s => `/* ${`${s.name} (${s.source})`.replace(/\*\//g, '* /')} */\n${sanitizeSnippetCss(s.css)}`)
    .join('\n\n');

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = combinedCss;
  document.head.appendChild(style);
}

export async function reloadSnippets(): Promise<void> {
  await loadEnabledSnippets();
}
