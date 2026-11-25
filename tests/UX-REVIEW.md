# UX Design Review — From E2E Screenshot Analysis

Reviewed 12 screenshots captured by agent-browser automated tests.
Date: 2026-03-24

## What's Working Well

1. **Dark theme** — good contrast, Catppuccin Mocha colors are cohesive
2. **Sidebar layout** — organized sections (pages, journals, stats)
3. **Settings panel** — compact, 2-column shortcuts grid looks professional
4. **Wiki links** — render as clickable blue text, clearly distinct
5. **Bold/inline formatting** — renders correctly in blocks
6. **Headings** — H1/H2 are visually distinct and properly sized
7. **Page header** — title + metadata (block count, updated time) is useful

## Issues Found

### High Priority

| # | Issue | Where | Fix |
|---|-------|-------|-----|
| 1 | **Nested blocks don't show indentation** | Project Alpha — Tasks/Notes children look flat | Verify `data-depth` is being set on nested blocks in the mock data |
| 2 | **TODO/DOING/DONE are plain text** — no color, no badge, just raw prefixes | Project Alpha | Add CSS for TODO (yellow), DOING (blue), DONE (green + strikethrough) |

### Medium Priority

| # | Issue | Where | Fix |
|---|-------|-------|-----|
| 3 | **"+ alias" visible on every page** — takes space, rarely used | All page headers | Hide by default, show on hover or via menu |
| 4 | **"Unlinked References" always visible** even when empty (shows 0) | Journal, Getting Started | Hide when no unlinked refs found |
| 5 | **H1 in first block redundant with page title** | Project Alpha — "# Project Alpha" block + "Project Alpha" header | Either hide the header when first block is H1, or don't duplicate |
| 6 | **Journal title is raw path format** | Journal header shows "Journal/2026-03-24" | Format as "Monday, March 24, 2026" |

### Low Priority (Polish)

| # | Issue | Where | Fix |
|---|-------|-------|-----|
| 7 | **Block bullets are very subtle** | All pages — tiny 4px dots at 40% opacity | Consider 5px at 50% or a slightly brighter color |
| 8 | **Graph selector "◇ default ▾"** is cryptic | Sidebar top | Rename to graph name or hide when only one graph |
| 9 | **Stats bar text is dense** | Sidebar bottom — "4 pages 22 blocks 0 links" | Could use icons instead of labels |
| 10 | **No empty state illustration** | Journal with 1 block looks bare | Add a subtle prompt or illustration for empty pages |

## Accessibility Notes

- Contrast ratios look good for text on dark background
- Interactive elements (buttons, links) are clearly clickable
- Keyboard shortcuts are well-documented in Settings
- Block editor is contenteditable — screen readers can access it
- TODO: verify focus indicators are visible for keyboard navigation

## Recommended Quick Wins (effort → impact)

1. **Hide empty "Unlinked References"** — 5 min, removes noise from every page
2. **Hide "+ alias" by default** — 5 min, declutters header
3. **Color TODO/DOING/DONE badges** — 15 min, major visual improvement
4. **Format journal date nicely** — 10 min, feels more polished
5. **Hide redundant H1 when page title matches** — 10 min, cleaner layout
