/**
 * `key:: value` typed in a block becomes a block property (UX Wave 4).
 *
 * Same key rule as the markdown copy's property lines (F-7, ARCH-findings): a
 * whole line `key:: value`, the key `[A-Za-z0-9_][A-Za-z0-9_.-]*`, then `::`
 * and a space (or the end of the line). The line leaves the block's text and
 * the property is set — so the mirror writes it as the indented `key:: value`
 * line under the block, and reading the mirror back gives the same property.
 * `::` anywhere else (`[[Work::Roadmap]]`, prose) stays text; so does anything
 * inside a ``` fence.
 */

const PROPERTY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)::(?:[ \t]+(.*?))?[ \t]*$/;

export interface TypedProperty {
  key: string;
  value: string;
}

/** The block's text without its `key:: value` lines, and those properties (last one of a key wins). */
export function extractTypedProperties(markdown: string): { content: string; properties: TypedProperty[] } {
  const lines = markdown.split("\n");
  const keep: string[] = [];
  const props = new Map<string, string>();
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : PROPERTY_LINE.exec(line);
    if (m) props.set(m[1], (m[2] ?? "").trim());
    else keep.push(line);
  }
  if (!props.size) return { content: markdown, properties: [] };
  return {
    content: keep.join("\n").replace(/^\n+|\n+$/g, ""),
    properties: [...props].map(([key, value]) => ({ key, value })),
  };
}

/** How the markdown copy writes a block property under its block (F-7), for tests and previews. */
export function propertyLine(key: string, value: string): string {
  return value ? `${key}:: ${value}` : `${key}::`;
}
