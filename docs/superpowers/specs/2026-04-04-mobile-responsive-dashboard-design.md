# Mobile-Responsive Dashboard — Design Spec

**Date:** 2026-04-04
**Goal:** Make the existing dashboard (`agents/dashboard/index.js`) fully functional on mobile devices.

## Approach

**CSS-only responsive** with targeted JS for interactive mobile patterns. Single breakpoint at `max-width: 768px`. No HTML restructuring of existing elements — pure CSS overrides plus a small amount of new HTML (bottom tab bar) and JS (accordion toggles, mobile menu).

Desktop layout remains untouched. All changes are scoped inside `@media (max-width: 768px) { ... }`.

---

## 1. Global Responsive Foundation

### Breakpoint
- Single breakpoint: `@media (max-width: 768px)`
- No changes above 768px — desktop layout stays exactly as-is

### Typography
- Base font size: `16px` minimum for all body text
- Table cells: `13px` minimum
- KPI labels: `11px` minimum
- No element below `10px`

### Touch Targets
- All interactive elements (buttons, links, tab pills, filter chips): `min-height: 44px; min-width: 44px`
- Padding increases on small buttons from `4px 12px` → `10px 16px`

### Layout
- Main container `max-width: 1400px` → `width: 100%; padding: 0 12px; box-sizing: border-box`
- Content area gets `padding-bottom: 64px` to clear the bottom tab bar

### Modals
- All modals become full-screen sheets: `width: 100vw; height: 100vh; max-width: none; max-height: none; border-radius: 0; margin: 0; top: 0; left: 0; transform: none`
- Close button gets larger touch target (44px)

### Chat Sidebar
- `width: 300px` fixed-right sidebar becomes a full-screen overlay
- Toggled by a chat button in the header; also accessible from the "More" menu in the bottom tab bar
- `z-index` above other content, dismiss by tapping outside or close button

---

## 2. Bottom Tab Bar

### New HTML Element
A new `<nav>` element appended to the body, hidden on desktop:

```
Position: fixed, bottom: 0, left: 0, right: 0
Height: 56px + safe-area-inset-bottom (for notched phones)
Background: matches header (#232342 or current theme)
Border-top: 1px solid rgba(255,255,255,.1)
z-index: 999
Display: none above 768px
```

### Tab Slots (5)
| Slot | Label | Action |
|------|-------|--------|
| 1 | SEO | Switch to SEO tab |
| 2 | CRO | Switch to CRO tab |
| 3 | Ads | Switch to Ads tab |
| 4 | Creatives | Switch to Creatives tab |
| 5 | More | Opens sheet with: Ad Intelligence, Optimize, action buttons (Run agents, etc.) |

Each slot: simple SVG icon (inline, 20×20) + label text (10px), vertically stacked, centered. Active tab uses accent color highlight on both icon and label.

### Header Changes (mobile only)
- Tab pills row: `display: none`
- Action buttons row: `display: none` (moved to "More" menu)
- Header shows: logo/title + compact KPI summary ("12 published · 4 scheduled") + chat toggle button
- KPI detail row collapses into the compact summary

---

## 3. SEO Tab

### KPI Header
- Desktop 5-column grid → 2-column grid with 3 rows (last row centers if odd)
- Each KPI card: slightly larger padding, number font 18px, label 11px
- Same data, reflowed layout

### Kanban → Stacked Accordion
- 6-column CSS grid → vertical stack of collapsible sections
- Each column becomes a row:
  - Tappable header: stage name (left) + count badge (right) + chevron indicator
  - `min-height: 44px` for touch
  - Tap toggles `.expanded` class (JS)
- Expanded state reveals the kanban cards as full-width stacked items
- One section expanded at a time (expanding one collapses others)
- Cards inside: full width, larger padding (12px), action buttons as pill-style with 44px min-height

### JS Addition
Small toggle function:
- On kanban header tap: toggle `.expanded` on clicked section
- Collapse other sections (single-expand behavior)
- Chevron rotates on expand

### Filter Chips
- Already `flex-wrap` — bump padding to `8px 16px`, font to `13px`

---

## 4. Data Tables

### Horizontal Scroll Wrapper
- Each table container gets `overflow-x: auto; -webkit-overflow-scrolling: touch`
- Applied to: rankings table, GSC keywords table, CRO metrics table, any other data table

### Sticky First Column
- First `<th>` and first `<td>` in each row: `position: sticky; left: 0; z-index: 1; background: inherit`
- Right-edge shadow on sticky column: `box-shadow: 2px 0 4px rgba(0,0,0,.1)` via `::after` pseudo-element

### Cell Adjustments
- Font size: `13px` minimum
- Padding: `10px 12px`
- `white-space: nowrap` stays on headers
- No structural changes — tables remain `<table>` elements

---

## 5. Creatives Tab

### Layout
- `grid-template-columns: 1fr 1fr` → `grid-template-columns: 1fr`
- `height: calc(100vh - 220px); overflow: hidden` → removed (natural document flow, full-page scroll)
- Order: image preview (top, full width) → action buttons → prompt/settings → filmstrip

### Image Preview
- Full width, `aspect-ratio` preserved
- Tap to view full-screen (existing lightbox)

### Action Buttons
- Refine, Download, Compare, Upscale in a horizontal row
- `display: flex; gap: 8px` with each button `flex: 1; min-height: 44px`

### Filmstrip
- Horizontally scrollable, `overflow-x: auto`
- Thumbnail size: `54px × 54px` (up from current smaller size)
- Delete icon: always visible on mobile (no hover state on touch devices)

### Reference Images
- Drag-and-drop zone replaced with "Add Image" button on mobile (drag-and-drop is unreliable on touch)
- Product image modal: full-screen (global modal rule)

### Compare Mode
- Side-by-side layout → vertically stacked (image A on top, image B below)
- `grid-template-columns: 1fr 1fr` → `grid-template-columns: 1fr`

---

## 6. CRO Tab

### Layout
- 2-column grid → single column (`grid-template-columns: 1fr`)
- Chart containers: full width
- CRO data table: horizontal scroll with sticky first column (same as Section 4)

---

## 7. Ads Tab

### Layout
- Campaign cards: full-width stacked
- Metric grids: single column
- Authority row: 4-column grid → 2x2 grid (`grid-template-columns: 1fr 1fr`)
- Ads optimizer suggestion cards: full-width stacked
- Weekly recap / campaign monitor sections: stack vertically

---

## Implementation Notes

### CSS Structure
All mobile styles go in a single `@media (max-width: 768px) { ... }` block appended to the existing `<style>` section in the template literal. No changes to existing CSS rules — only additive overrides.

### JS Additions
Minimal new JavaScript:
1. **Accordion toggle** — click handler on kanban column headers to expand/collapse
2. **Bottom tab bar** — uses existing `switchTab()` function, just wired to new bottom nav elements
3. **"More" menu** — simple show/hide overlay

### Template Literal Rules
Per CLAUDE.md code review checklist:
- No `\n` inside string literals in the `<script>` block (use `\\n`)
- No `\'` (use `&apos;`)
- No `\s` in regex (use `[ ]` or `[ \\t\\r\\n]`)

### Testing
- Chrome DevTools device toolbar (iPhone SE, iPhone 14 Pro, iPad Mini)
- Verify all tabs render and are functional
- Verify all modals open full-screen and can be dismissed
- Verify tables scroll horizontally with sticky first column
- Verify kanban accordion expands/collapses correctly
- Verify bottom tab bar switches tabs and "More" menu works
- Test on actual mobile device before deploying to server
