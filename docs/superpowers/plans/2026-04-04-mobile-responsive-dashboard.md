# Mobile-Responsive Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard fully functional on mobile devices with a single CSS breakpoint and minimal JS additions.

**Architecture:** CSS-only responsive at `max-width: 768px` breakpoint, added as a single `@media` block appended to the existing `<style>` section. Three small JS additions: bottom tab bar wiring, kanban accordion toggle, and "More" menu. One new HTML element (bottom tab bar `<nav>`) inserted before `</body>`. All changes scoped to mobile — desktop layout untouched.

**Tech Stack:** CSS media queries, vanilla JS (no frameworks). All code lives in `agents/dashboard/index.js` inside the existing template literal.

**Spec:** `docs/superpowers/specs/2026-04-04-mobile-responsive-dashboard-design.md`

**Critical rules for this file (from CLAUDE.md):**
- All browser JS lives inside a Node.js template literal — `\n` must be `\\n`, `\'` must be `&apos;`, `\s` in regex must be `[ ]`
- Test locally before pushing to server
- Work on a branch, never commit directly to main

---

### Task 1: Create branch and add bottom tab bar HTML

**Files:**
- Modify: `agents/dashboard/index.js:5373` (before `</body>` at line 5374)

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feature/mobile-responsive-dashboard
```

- [ ] **Step 2: Add bottom tab bar HTML before `</body>`**

Insert the following HTML at line 5373, right before the `</body>` tag:

```html
<!-- Mobile bottom tab bar -->
<nav id="mobile-tab-bar">
  <button class="mobile-tab active" onclick="mobileTabSwitch(&apos;seo&apos;,this)">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
    <span>SEO</span>
  </button>
  <button class="mobile-tab" onclick="mobileTabSwitch(&apos;cro&apos;,this)">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
    <span>CRO</span>
  </button>
  <button class="mobile-tab" onclick="mobileTabSwitch(&apos;ads&apos;,this)">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
    <span>Ads</span>
  </button>
  <button class="mobile-tab" onclick="mobileTabSwitch(&apos;creatives&apos;,this)">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
    <span>Creatives</span>
  </button>
  <button class="mobile-tab" onclick="toggleMoreMenu()">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
    <span>More</span>
  </button>
</nav>

<!-- Mobile "More" menu overlay -->
<div id="mobile-more-menu" style="display:none">
  <div class="mobile-more-backdrop" onclick="toggleMoreMenu()"></div>
  <div class="mobile-more-sheet">
    <div class="mobile-more-title">More</div>
    <button class="mobile-more-item" onclick="mobileTabSwitch(&apos;ad-intelligence&apos;);toggleMoreMenu()">Ad Intelligence</button>
    <button class="mobile-more-item" onclick="mobileTabSwitch(&apos;optimize&apos;);toggleMoreMenu()">Optimize</button>
    <div class="mobile-more-divider"></div>
    <button class="mobile-more-item" onclick="toggleTabChat();toggleMoreMenu()">Chat</button>
  </div>
</div>
```

- [ ] **Step 3: Verify the file still parses**

```bash
node -e "require('./agents/dashboard/index.js')" 2>&1 | head -5
```

Expected: Server starts (or no syntax error). Press Ctrl+C to stop.

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat(mobile): add bottom tab bar and More menu HTML"
```

---

### Task 2: Add mobile JS functions

**Files:**
- Modify: `agents/dashboard/index.js` — inside `<script>` block, after the `switchTab()` function (after ~line 1430)

- [ ] **Step 1: Add mobileTabSwitch, toggleMoreMenu, and accordion toggle functions**

Insert after the `switchTab()` function closing brace:

```javascript
// ── Mobile responsive helpers ────────────────────────────────────────────────

function mobileTabSwitch(name, btn) {
  // Reuse existing switchTab — find the matching desktop pill to pass as btn arg
  var pill = document.querySelector('.tab-pill[onclick*="' + name + '"]');
  if (pill) switchTab(name, pill);
  // Update mobile tab bar active state
  document.querySelectorAll('.mobile-tab').forEach(function(t) { t.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  // If opened from More menu, highlight the More button
  if (!btn) {
    var moreBtn = document.querySelector('#mobile-tab-bar .mobile-tab:last-child');
    if (moreBtn) moreBtn.classList.add('active');
  }
}

function toggleMoreMenu() {
  var menu = document.getElementById('mobile-more-menu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? '' : 'none';
}

function toggleKanbanAccordion(header) {
  var col = header.closest('.kanban-col');
  if (!col) return;
  var wasExpanded = col.classList.contains('expanded');
  // Collapse all columns first (single-expand behavior)
  document.querySelectorAll('.kanban-col.expanded').forEach(function(c) { c.classList.remove('expanded'); });
  // Toggle clicked column
  if (!wasExpanded) col.classList.add('expanded');
}
```

- [ ] **Step 2: Update renderKanban to add click handlers on column headers**

Modify the `renderKanban` function (line ~1723). Change the kanban column HTML generation from:

```javascript
    return '<div class="kanban-col col-' + col.key + '">' +
      '<div class="kanban-head">' + col.label + '</div>' +
      '<div class="kanban-count">' + items.length + '</div>' +
      (items.length ? '<div class="kanban-items">' + itemsHtml + '</div>' : '') +
      '</div>';
```

To:

```javascript
    return '<div class="kanban-col col-' + col.key + '">' +
      '<div class="kanban-head" onclick="toggleKanbanAccordion(this)">' +
        '<span class="kanban-head-label">' + col.label + '</span>' +
        '<span class="kanban-head-count">' + items.length + '</span>' +
        '<span class="kanban-chevron">&#9660;</span>' +
      '</div>' +
      '<div class="kanban-count">' + items.length + '</div>' +
      (items.length ? '<div class="kanban-items">' + itemsHtml + '</div>' : '') +
      '</div>';
```

- [ ] **Step 3: Update switchTab to sync mobile tab bar active state**

Add the following at the end of the existing `switchTab()` function body (before its closing brace):

```javascript
  // Sync mobile tab bar active state
  document.querySelectorAll('.mobile-tab').forEach(function(t) { t.classList.remove('active'); });
  var mobileNames = ['seo','cro','ads','creatives'];
  var mobileIdx = mobileNames.indexOf(name);
  var mobileTabs = document.querySelectorAll('.mobile-tab');
  if (mobileIdx >= 0 && mobileTabs[mobileIdx]) {
    mobileTabs[mobileIdx].classList.add('active');
  } else if (mobileTabs.length > 4) {
    mobileTabs[4].classList.add('active');
  }
```

- [ ] **Step 4: Verify no syntax errors**

```bash
node -e "require('./agents/dashboard/index.js')" 2>&1 | head -5
```

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat(mobile): add tab switching, More menu, and accordion toggle JS"
```

---

### Task 3: Add mobile CSS — global foundation, bottom tab bar, header

**Files:**
- Modify: `agents/dashboard/index.js` — append to `<style>` block (before `</style>` at ~line 1059)

- [ ] **Step 1: Add the `@media` block with global foundation, bottom tab bar, and header styles**

Insert before the `</style>` closing tag:

```css
/* ── Mobile responsive ──────────────────────────────────────────────────── */

#mobile-tab-bar { display: none; }
#mobile-more-menu .mobile-more-backdrop { display: none; }
#mobile-more-menu .mobile-more-sheet { display: none; }

@media (max-width: 768px) {

  /* ── Global foundation ─────────────────────────────────────────────── */
  body { font-size: 16px; }
  .main-container, [style*="max-width: 1400px"], [style*="max-width:1400px"] {
    max-width: 100% !important;
    padding-left: 12px !important;
    padding-right: 12px !important;
    box-sizing: border-box;
  }
  .tab-panel.active { padding: 12px; padding-bottom: 80px; }
  button, a, .filter-chip, .tab-pill, .kanban-item { min-height: 44px; }

  /* ── Bottom tab bar ────────────────────────────────────────────────── */
  #mobile-tab-bar {
    display: flex;
    position: fixed;
    bottom: 0; left: 0; right: 0;
    height: 56px;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    background: #232342;
    border-top: 1px solid rgba(255,255,255,.1);
    z-index: 999;
    justify-content: space-around;
    align-items: center;
  }
  .mobile-tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    background: none;
    border: none;
    color: #94a3b8;
    font-size: 10px;
    padding: 4px 0;
    cursor: pointer;
    flex: 1;
    min-height: 56px;
  }
  .mobile-tab.active { color: #818cf8; }
  .mobile-tab svg { stroke: currentColor; }

  /* ── More menu ─────────────────────────────────────────────────────── */
  #mobile-more-menu .mobile-more-backdrop {
    display: block;
    position: fixed; inset: 0;
    background: rgba(0,0,0,.5);
    z-index: 1000;
  }
  #mobile-more-menu .mobile-more-sheet {
    display: block;
    position: fixed;
    bottom: 0; left: 0; right: 0;
    background: #1e1e3a;
    border-radius: 16px 16px 0 0;
    padding: 20px 16px;
    padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    z-index: 1001;
  }
  .mobile-more-title {
    font-size: 16px; font-weight: 600; color: #e2e8f0;
    margin-bottom: 12px;
  }
  .mobile-more-item {
    display: block; width: 100%;
    padding: 14px 12px;
    background: none; border: none;
    color: #e2e8f0; font-size: 15px;
    text-align: left; cursor: pointer;
    border-radius: 8px;
  }
  .mobile-more-item:active { background: rgba(255,255,255,.05); }
  .mobile-more-divider {
    height: 1px; background: rgba(255,255,255,.1);
    margin: 8px 0;
  }

  /* ── Header ────────────────────────────────────────────────────────── */
  .hero { padding: 10px 12px 8px; }
  .tab-pills { display: none !important; }
  .tab-actions-bar { display: none !important; }
  .hero-meta { font-size: 12px; }

}
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node -e "require('./agents/dashboard/index.js')" 2>&1 | head -5
```

- [ ] **Step 3: Test in browser**

```bash
cd agents/dashboard && node index.js &
```

Open `http://localhost:4242` in Chrome. Open DevTools (F12) → toggle device toolbar (Ctrl+Shift+M) → select "iPhone 14 Pro" or set width to 375px.

Verify:
- Bottom tab bar visible with 5 icons
- Desktop tab pills hidden
- Action buttons row hidden
- Tapping tab bar icons switches tabs
- "More" opens a bottom sheet with Ad Intelligence, Optimize, Chat
- Desktop view (resize above 768px) shows no bottom bar, normal pills

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat(mobile): add global foundation, bottom tab bar, and header CSS"
```

---

### Task 4: Add mobile CSS — KPI grid and kanban accordion

**Files:**
- Modify: `agents/dashboard/index.js` — inside the `@media (max-width: 768px)` block added in Task 3

- [ ] **Step 1: Add KPI and kanban mobile styles**

Append inside the `@media` block (before its closing `}`):

```css
  /* ── KPI grid ──────────────────────────────────────────────────────── */
  .hero-kpis {
    grid-template-columns: repeat(2, 1fr) !important;
  }
  .hero-kpi { padding: 8px 10px; }
  .hero-kpi-value { font-size: 18px; }
  .hero-kpi-label { font-size: 11px; }

  /* ── Kanban accordion ──────────────────────────────────────────────── */
  .kanban {
    display: flex !important;
    flex-direction: column !important;
    gap: 0 !important;
  }
  .kanban-col {
    border-radius: 0;
    border-bottom: 1px solid var(--border);
  }
  .kanban-col:first-child { border-radius: 8px 8px 0 0; }
  .kanban-col:last-child { border-radius: 0 0 8px 8px; border-bottom: none; }
  .kanban-head {
    display: flex !important;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    cursor: pointer;
    min-height: 44px;
    box-sizing: border-box;
  }
  .kanban-head-label { font-size: 14px; font-weight: 600; }
  .kanban-head-count {
    background: var(--indigo);
    color: #fff;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    margin-left: auto;
    margin-right: 8px;
  }
  .kanban-chevron {
    font-size: 10px;
    color: #94a3b8;
    transition: transform 0.2s;
  }
  .kanban-col.expanded .kanban-chevron {
    transform: rotate(180deg);
  }
  .kanban-count { display: none !important; }
  .kanban-items {
    display: none;
    padding: 0 14px 12px;
  }
  .kanban-col.expanded .kanban-items { display: block; }
  .kanban-item {
    padding: 10px 12px;
    font-size: 13px;
    margin-bottom: 6px;
  }
  .kanban-item .kw { font-size: 13px; }
  .kw-reject-btn {
    font-size: 12px !important;
    padding: 6px 12px !important;
    min-height: 36px;
  }

  /* ── Filter chips ──────────────────────────────────────────────────── */
  .filter-chip {
    font-size: 13px !important;
    padding: 8px 16px !important;
  }
```

- [ ] **Step 2: Test in browser at mobile width**

Verify:
- KPIs reflow to 2-column grid
- Kanban shows as stacked accordion — column names with count badges and chevrons
- Tapping a column header expands it to show items
- Expanding one column collapses the previously open one
- Kanban items are full-width with larger text and touch targets
- Filter chips are larger

- [ ] **Step 3: Verify desktop is unchanged**

Resize above 768px. Kanban should show the normal 6-column grid. KPIs should be 5 columns. The `.kanban-chevron`, `.kanban-head-label`, and `.kanban-head-count` elements are new but won't affect desktop layout since they're inline within the existing header.

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat(mobile): add KPI grid reflow and kanban accordion styles"
```

---

### Task 5: Add mobile CSS — data tables with sticky first column

**Files:**
- Modify: `agents/dashboard/index.js` — inside the `@media (max-width: 768px)` block

- [ ] **Step 1: Add table responsive styles**

Append inside the `@media` block:

```css
  /* ── Data tables ───────────────────────────────────────────────────── */
  .gsc-table, .cro-table {
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    max-width: 100%;
  }
  table thead th { font-size: 11px; padding: 8px 10px; }
  table tbody td { font-size: 13px; padding: 10px 12px; }
  table thead th:first-child,
  table tbody td:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--card-bg, #fff);
  }
  table thead th:first-child::after,
  table tbody td:first-child::after {
    content: '';
    position: absolute;
    right: 0; top: 0; bottom: 0;
    width: 4px;
    box-shadow: 2px 0 4px rgba(0,0,0,.08);
  }

  /* ── Authority row (4-col → 2x2) ──────────────────────────────────── */
  .authority-row {
    grid-template-columns: repeat(2, 1fr) !important;
  }
  .authority-stat { padding: 10px 12px; }

  /* ── Brief grid (3-col → 1-col) ───────────────────────────────────── */
  .brief-grid {
    grid-template-columns: 1fr !important;
  }
```

- [ ] **Step 2: Test in browser at mobile width**

Verify:
- Tables scroll horizontally with touch/swipe
- First column stays fixed while scrolling
- Subtle shadow visible on first column edge
- Authority row shows 2x2 grid instead of 4 columns
- Brief cards stack vertically

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat(mobile): add responsive tables with sticky first column"
```

---

### Task 6: Add mobile CSS — Creatives tab single-column layout

**Files:**
- Modify: `agents/dashboard/index.js` — inside the `@media (max-width: 768px)` block

- [ ] **Step 1: Add Creatives tab mobile styles**

Append inside the `@media` block:

```css
  /* ── Creatives tab ─────────────────────────────────────────────────── */
  #tab-creatives .creatives-layout,
  #tab-creatives > div[style*="grid-template-columns: 1fr 1fr"],
  #tab-creatives > div[style*="grid-template-columns:1fr 1fr"] {
    display: flex !important;
    flex-direction: column !important;
    height: auto !important;
    overflow: visible !important;
  }
  #tab-creatives .creatives-layout > div,
  #tab-creatives > div > div {
    border-right: none !important;
    overflow-y: visible !important;
    height: auto !important;
  }

  /* Image preview full width */
  #creatives-right-panel {
    order: -1;
    border-right: none !important;
    padding: 12px !important;
  }

  /* Prompt panel below */
  #tab-creatives .creatives-layout > div:first-child {
    padding: 12px !important;
  }

  /* Action buttons row */
  #tab-creatives button {
    min-height: 44px;
  }

  /* Filmstrip */
  .creatives-filmstrip, #creatives-filmstrip,
  div[style*="overflow-x"] {
    -webkit-overflow-scrolling: touch;
  }
  .creatives-filmstrip img,
  #creatives-filmstrip img {
    width: 54px !important;
    height: 54px !important;
  }

  /* Delete icon always visible on mobile (no hover) */
  .filmstrip-delete, .creative-delete {
    opacity: 1 !important;
  }

  /* Compare mode — stack vertically */
  .compare-grid,
  div[style*="grid-template-columns: 1fr 1fr"][class*="compare"],
  #compare-container {
    grid-template-columns: 1fr !important;
  }

  /* Reference image drop zone → button */
  .drop-zone, [class*="drop-zone"], [class*="dropzone"] {
    min-height: 60px;
  }
```

- [ ] **Step 2: Test in browser at mobile width**

Verify:
- Creatives tab shows single column: image on top, prompt below
- No fixed height constraint — page scrolls naturally
- Filmstrip thumbnails are 54px and scrollable
- Compare mode stacks vertically
- Action buttons are full-width with 44px height
- Delete icons on filmstrip are always visible (not hover-only)

- [ ] **Step 3: Verify desktop is unchanged**

Resize above 768px. Creatives should show side-by-side two-panel layout with fixed height.

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat(mobile): add Creatives tab single-column responsive layout"
```

---

### Task 7: Add mobile CSS — modals, chat sidebar, CRO/Ads grids

**Files:**
- Modify: `agents/dashboard/index.js` — inside the `@media (max-width: 768px)` block

- [ ] **Step 1: Add modal, chat, and remaining grid styles**

Append inside the `@media` block:

```css
  /* ── Modals → full-screen sheets ───────────────────────────────────── */
  #product-image-modal > div,
  #template-modal > div,
  .brief-detail,
  div[style*="max-width: 660px"],
  div[style*="max-width:660px"] {
    width: 100vw !important;
    height: 100vh !important;
    max-width: none !important;
    max-height: none !important;
    border-radius: 0 !important;
    margin: 0 !important;
    top: 0 !important;
    left: 0 !important;
    transform: none !important;
  }
  /* Modal close buttons — larger touch target */
  #product-image-modal button[onclick*="close"],
  #template-modal button[onclick*="close"],
  .brief-detail button[onclick*="close"] {
    min-width: 44px !important;
    min-height: 44px !important;
    font-size: 20px !important;
  }

  /* ── Chat sidebar → full-screen overlay ────────────────────────────── */
  .tab-chat-sidebar {
    width: 100vw !important;
    top: 0 !important;
    right: 0 !important;
    bottom: 56px !important;
    border-radius: 0 !important;
    z-index: 998 !important;
  }
  .tab-chat-input { font-size: 16px !important; }

  /* ── CRO tab (2-col → 1-col) ───────────────────────────────────────── */
  #tab-cro .tab-panel-grid,
  #tab-cro > div[style*="grid-template-columns"] {
    grid-template-columns: 1fr !important;
  }
  .cro-grid, .cro-row {
    grid-template-columns: 1fr !important;
  }

  /* ── Ads tab grids ─────────────────────────────────────────────────── */
  #tab-ads .tab-panel-grid,
  #tab-ads > div[style*="grid-template-columns"] {
    grid-template-columns: 1fr !important;
  }
  .campaign-cards, .ads-grid, .ads-metrics {
    grid-template-columns: 1fr !important;
  }

} /* end @media */
```

- [ ] **Step 2: Test in browser at mobile width — full walkthrough**

Walk through every tab and feature:

1. **Bottom tab bar**: all 5 buttons work, active state syncs with desktop pills
2. **More menu**: opens bottom sheet, items switch tabs correctly, backdrop closes menu
3. **SEO tab**: KPIs 2-column, kanban accordion works, tables scroll with sticky column
4. **CRO tab**: single-column layout, tables scroll
5. **Ads tab**: single-column layout, authority row 2x2
6. **Creatives tab**: single-column (image top, prompt below), filmstrip scrolls, compare stacks
7. **Modals**: open full-screen, close buttons work, content scrollable
8. **Chat**: opens full-screen overlay, input works, closes properly
9. **Desktop**: resize above 768px — everything unchanged

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat(mobile): add full-screen modals, chat overlay, CRO/Ads responsive grids"
```

---

### Task 8: Test on device, fix issues, merge and deploy

**Files:**
- Modify: `agents/dashboard/index.js` (if fixes needed)

- [ ] **Step 1: Test on actual mobile device**

Start the dashboard locally and access from a phone on the same network, or use the server:

```bash
node agents/dashboard/index.js
```

Open on phone: `http://<local-ip>:4242`

Test all tabs, modals, kanban accordion, table scrolling, creatives workflow, chat. Note any issues.

- [ ] **Step 2: Fix any issues found**

Common mobile issues to watch for:
- Text input zoom on iOS (inputs with font-size < 16px cause auto-zoom)
- Viewport bounce/overscroll on body
- Bottom tab bar overlapping content
- Touch targets still too small on specific elements
- Overflow issues on specific content

- [ ] **Step 3: Commit fixes (if any)**

```bash
git add agents/dashboard/index.js
git commit -m "fix(mobile): address device testing issues"
```

- [ ] **Step 4: Merge to main and deploy**

```bash
git checkout main
git merge feature/mobile-responsive-dashboard
git push
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

- [ ] **Step 5: Verify on server**

```bash
ssh root@137.184.119.230 'pm2 status && pm2 logs seo-dashboard --lines 5 --nostream'
```

Open `http://137.184.119.230:4242` on phone to verify production deployment.
