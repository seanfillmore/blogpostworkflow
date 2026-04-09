# Dashboard UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scrollable kanban columns, sort/filter/search to keyword rankings table, pagination to posts table, and an image lightbox popup to the SEO dashboard.

**Architecture:** All changes are in `agents/dashboard/index.js` — a single-file Node.js server that serves an inline HTML/CSS/JS dashboard. Browser JS lives inside a Node.js template literal (the `HTML` constant). One new HTTP route is added to serve local images. All rendering logic is client-side JS within that template.

**Tech Stack:** Node.js HTTP server, vanilla browser JS, inline CSS — no external libraries.

---

## Critical: Escape sequence rule

All new browser JS strings inside the `HTML` template literal must use `\\n` not `\n` for newlines. **Regex patterns must not use `\s`, `\t`, `\r`, or `\n`** — Node.js converts these before the browser sees them. Use `[ ]` for space-only matches. See the CLAUDE.md dashboard checklist.

---

## Files

- **Modify:** `agents/dashboard/index.js:16` — add `createReadStream` to the `fs` import
- **Modify:** `agents/dashboard/index.js:603–625` — add CSS for scrollable kanban items + lightbox overlay
- **Modify:** `agents/dashboard/index.js:1313–1331` — `renderKanban`: remove 20-item cap, allow full scroll
- **Modify:** `agents/dashboard/index.js:1334–1386` — replace `rankPage`/`RANK_PAGE_SIZE` globals and `renderRankings` with new version including search, sort, filter
- **Modify:** `agents/dashboard/index.js:1389–1426` — replace `renderPosts` with paginated version + image lightbox
- **Modify:** `agents/dashboard/index.js:3064` — add `/images/:slug` route before the `/api/data` route

---

## Task 1: Create feature branch

- [ ] **Step 1: Create and checkout branch**

```bash
git checkout -b feature/dashboard-ux-improvements
```

- [ ] **Step 2: Verify branch**

```bash
git branch --show-current
```
Expected: `feature/dashboard-ux-improvements`

---

## Task 2: Add `createReadStream` to fs import

- [ ] **Step 1: Update the import on line 16**

Find:
```js
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs';
```

Replace with:
```js
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, createReadStream } from 'fs';
```

---

## Task 3: Add `/images/:slug` HTTP route

- [ ] **Step 1: Add image route before the `/api/data` handler**

Find the line:
```js
  if (req.url === '/api/data') {
```

Insert this block immediately before it:
```js
  if (req.method === 'GET' && req.url.startsWith('/images/')) {
    if (!checkAuth(req, res)) return;
    const slug = req.url.slice('/images/'.length).split('?')[0];
    if (!/^[a-z0-9-]+$/.test(slug)) { res.writeHead(400); res.end('Bad request'); return; }
    const webp = join(IMAGES_DIR, `${slug}.webp`);
    const png  = join(IMAGES_DIR, `${slug}.png`);
    const imgPath = existsSync(webp) ? webp : existsSync(png) ? png : null;
    if (!imgPath) { res.writeHead(404); res.end('Not found'); return; }
    const ct = imgPath.endsWith('.webp') ? 'image/webp' : 'image/png';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
    createReadStream(imgPath).pipe(res);
    return;
  }

```

---

## Task 4: Add CSS for scrollable kanban items and lightbox

- [ ] **Step 1: Update `.kanban-items` CSS to be scrollable**

Find (around line 608):
```css
  .kanban-items { padding: 0 8px 8px; display: grid; gap: 4px; }
```

Replace with:
```css
  .kanban-items { padding: 0 8px 8px; display: grid; gap: 4px; max-height: 220px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #d1d5db transparent; }
```

- [ ] **Step 2: Add lightbox and rank filter CSS**

Find (the end of the kanban CSS block, after line 625):
```css
  .col-pending   .kanban-head { background: #f8fafc; color: var(--muted); }
  .col-pending   .kanban-item { background: #f8fafc; }
```

Add after it:
```css
  .col-pending   .kanban-head { background: #f8fafc; color: var(--muted); }
  .col-pending   .kanban-item { background: #f8fafc; }

  /* ── image lightbox ── */
  #img-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,.85); z-index: 9999; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  #img-modal-overlay img { max-width: 90vw; max-height: 90vh; border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,.5); cursor: default; }

  /* ── rank filter chips ── */
  .filter-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .filter-chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e0e7ff; color: #3730a3; display: flex; align-items: center; gap: 4px; }
  .filter-chip-x { cursor: pointer; font-size: 13px; line-height: 1; color: #6366f1; }
  .filter-chip-x:hover { color: #ef4444; }

  /* ── rank table header sort/filter ── */
  .th-inner { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .th-sort { cursor: pointer; user-select: none; }
  .th-sort:hover { color: var(--text); }
  .th-filter-wrap { position: relative; display: inline-flex; }
  .th-filter-btn { cursor: pointer; font-size: 10px; padding: 0 3px; color: var(--muted); user-select: none; }
  .th-filter-btn:hover { color: var(--text); }
  .th-filter-btn.active { color: #3b82f6; }
  .th-filter-menu { display: none; position: absolute; top: 100%; left: 0; background: #fff; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px; z-index: 200; min-width: 130px; box-shadow: 0 4px 12px rgba(0,0,0,.1); }
  .th-filter-menu.open { display: block; }
  .th-filter-opt { padding: 5px 10px; font-size: 12px; cursor: pointer; border-radius: 4px; text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--text); }
  .th-filter-opt:hover { background: #f3f4f6; }
  .th-filter-opt.selected { font-weight: 600; color: #3b82f6; }
```

**Note:** Replace the duplicate `.col-pending` lines — keep only the one that includes both new CSS blocks below it. The old `.col-pending` lines remain; just add the new blocks after them.

- [ ] **Step 2 (corrected): Add new CSS blocks after the existing col-pending lines**

The existing file already has:
```css
  .col-pending   .kanban-head { background: #f8fafc; color: var(--muted); }
  .col-pending   .kanban-item { background: #f8fafc; }
```

Find that exact text and replace with:
```css
  .col-pending   .kanban-head { background: #f8fafc; color: var(--muted); }
  .col-pending   .kanban-item { background: #f8fafc; }

  /* ── image lightbox ── */
  #img-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,.85); z-index: 9999; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  #img-modal-overlay img { max-width: 90vw; max-height: 90vh; border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,.5); cursor: default; }

  /* ── rank filter chips ── */
  .filter-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .filter-chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e0e7ff; color: #3730a3; display: flex; align-items: center; gap: 4px; }
  .filter-chip-x { cursor: pointer; font-size: 13px; line-height: 1; color: #6366f1; }
  .filter-chip-x:hover { color: #ef4444; }

  /* ── rank table header sort/filter ── */
  .th-inner { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .th-sort { cursor: pointer; user-select: none; }
  .th-sort:hover { color: var(--text); }
  .th-filter-wrap { position: relative; display: inline-flex; }
  .th-filter-btn { cursor: pointer; font-size: 10px; padding: 0 3px; color: var(--muted); user-select: none; }
  .th-filter-btn:hover { color: var(--text); }
  .th-filter-btn.active { color: #3b82f6; }
  .th-filter-menu { display: none; position: absolute; top: 100%; left: 0; background: #fff; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px; z-index: 200; min-width: 130px; box-shadow: 0 4px 12px rgba(0,0,0,.1); }
  .th-filter-menu.open { display: block; }
  .th-filter-opt { padding: 5px 10px; font-size: 12px; cursor: pointer; border-radius: 4px; text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--text); }
  .th-filter-opt:hover { background: #f3f4f6; }
  .th-filter-opt.selected { font-weight: 600; color: #3b82f6; }
```

---

## Task 5: Update `renderKanban` — remove item cap, enable scroll

- [ ] **Step 1: Remove the `slice(0, 20)` cap and the `more` indicator**

Find (inside `renderKanban`, around line 1313):
```js
    const itemsHtml = items.slice(0, 20).map(i => {
      const dateStr = i.publishDate ? fmtDate(i.publishDate) : null;
      const dateLine = dateStr && col.key === 'scheduled' ? '<div class="pub-date-scheduled">' + dateStr + '</div>'
                     : dateStr && col.key === 'published'  ? '<div class="pub-date-published">' + dateStr + '</div>'
                     : '';
      return '<div class="kanban-item"><div class="kw">' + esc(i.keyword) + '</div>' +
        dateLine +
        (i.volume ? '<div class="vol">' + fmtNum(i.volume) + '/mo</div>' : '') + '</div>';
    }).join('');
    const more = items.length > 20 ? '<div class="muted" style="font-size:11px;padding-top:4px">+' + (items.length - 20) + ' more</div>' : '';
    return '<div class="kanban-col col-' + col.key + '">' +
      '<div class="kanban-head">' + col.label + '</div>' +
      '<div class="kanban-count">' + items.length + '</div>' +
      (items.length ? '<div class="kanban-items">' + itemsHtml + more + '</div>' : '') +
      '</div>';
```

Replace with:
```js
    const itemsHtml = items.map(i => {
      const dateStr = i.publishDate ? fmtDate(i.publishDate) : null;
      const dateLine = dateStr && col.key === 'scheduled' ? '<div class="pub-date-scheduled">' + dateStr + '</div>'
                     : dateStr && col.key === 'published'  ? '<div class="pub-date-published">' + dateStr + '</div>'
                     : '';
      return '<div class="kanban-item"><div class="kw">' + esc(i.keyword) + '</div>' +
        dateLine +
        (i.volume ? '<div class="vol">' + fmtNum(i.volume) + '/mo</div>' : '') + '</div>';
    }).join('');
    return '<div class="kanban-col col-' + col.key + '">' +
      '<div class="kanban-head">' + col.label + '</div>' +
      '<div class="kanban-count">' + items.length + '</div>' +
      (items.length ? '<div class="kanban-items">' + itemsHtml + '</div>' : '') +
      '</div>';
```

---

## Task 6: Replace rankings state + add helper functions + rewrite `renderRankings`

- [ ] **Step 1: Replace state variable declarations**

Find (around line 1334):
```js
let rankPage = 0;
const RANK_PAGE_SIZE = 20;
```

Replace with:
```js
let rankPage    = 0;
let rankSearch  = '';
let rankSort    = { col: null, dir: null };
let rankFilters = { position: 'all', change: 'all', volume: 'all', tier: 'all' };
const RANK_PAGE_SIZE = 10;

function sortRankBy(col) {
  if (rankSort.col === col) {
    if (rankSort.dir === 'asc') { rankSort.dir = 'desc'; }
    else if (rankSort.dir === 'desc') { rankSort.col = null; rankSort.dir = null; }
    else { rankSort.dir = 'asc'; }
  } else {
    rankSort.col = col; rankSort.dir = 'asc';
  }
  rankPage = 0;
  renderRankings(data);
}

function toggleRankMenu(key) {
  const el = document.getElementById('rmenu-' + key);
  if (!el) return;
  const wasOpen = el.classList.contains('open');
  ['position', 'change', 'volume', 'tier'].forEach(function(k) {
    const m = document.getElementById('rmenu-' + k);
    if (m) m.classList.remove('open');
  });
  if (!wasOpen) el.classList.add('open');
}

function setRankFilter(key, val) {
  rankFilters[key] = val;
  rankPage = 0;
  const el = document.getElementById('rmenu-' + key);
  if (el) el.classList.remove('open');
  renderRankings(data);
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('.th-filter-wrap')) {
    ['position', 'change', 'volume', 'tier'].forEach(function(k) {
      const m = document.getElementById('rmenu-' + k);
      if (m) m.classList.remove('open');
    });
  }
});
```

- [ ] **Step 2: Replace `renderRankings` function**

Find (lines 1337–1387):
```js
function renderRankings(d) {
  const r = d.rankings;
  if (!r.items.length) {
    document.getElementById('rankings-table').innerHTML = '<div class="empty">No rank snapshots yet. Run <code>npm run rank-tracker</code> to generate one.</div>';
    return;
  }

  const note = r.latestDate ? r.latestDate + (r.previousDate ? ' vs ' + r.previousDate : '') : '';
  document.getElementById('rank-note').textContent = note;

  const tierBadge = t => {
    if (t === 'page1')     return badge('page1', 'Page 1');
    if (t === 'quickWins') return badge('quickwins', 'Quick Win');
    if (t === 'needsWork') return badge('needswork-rank', 'Needs Work');
    return badge('notranking', 'Not Ranking');
  };

  const changeHtml = x => {
    if (x.change == null) return '<span class="muted">—</span>';
    if (x.change > 0) return '<span class="change change-up">↑ ' + x.change + '</span>';
    if (x.change < 0) return '<span class="change change-down">↓ ' + Math.abs(x.change) + '</span>';
    return '<span class="change change-flat">→ 0</span>';
  };

  const totalPages = Math.ceil(r.items.length / RANK_PAGE_SIZE);
  rankPage = Math.max(0, Math.min(rankPage, totalPages - 1));
  const pageItems = r.items.slice(rankPage * RANK_PAGE_SIZE, (rankPage + 1) * RANK_PAGE_SIZE);

  const rows = pageItems.map((x, i) => {
    const idx = rankPage * RANK_PAGE_SIZE + i;
    return '<tr style="cursor:pointer" onclick="openKeywordCard(data.rankings.items[' + idx + '])">' +
    '<td>' + esc(x.keyword) + (x.tracked ? ' <span class="muted" style="font-size:10px">●</span>' : '') + '</td>' +
    '<td class="nowrap"><span class="pos">' + (x.position != null ? '#' + x.position : '—') + '</span></td>' +
    '<td class="nowrap">' + changeHtml(x) + (x.previousPosition != null ? '<span class="muted" style="font-size:11px;margin-left:4px">was #' + x.previousPosition + '</span>' : '') + '</td>' +
    '<td class="nowrap muted">' + fmtNum(x.volume) + '</td>' +
    '<td>' + tierBadge(x.tier) + '</td>' +
    '</tr>';
  }).join('');

  const pagination =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:13px;">' +
    '<button onclick="rankPage--;renderRankings(data)" ' + (rankPage === 0 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">← Prev</button>' +
    '<span class="muted">Page ' + (rankPage + 1) + ' of ' + totalPages + ' (' + r.items.length + ' keywords)</span>' +
    '<button onclick="rankPage++;renderRankings(data)" ' + (rankPage >= totalPages - 1 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">Next →</button>' +
    '</div>';

  document.getElementById('rankings-table').innerHTML =
    '<table><thead><tr>' +
    '<th>Keyword</th><th>Position</th><th>Change</th><th>Volume</th><th>Tier</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + pagination;
}
```

Replace with:
```js
function renderRankings(d) {
  const r = d.rankings;
  if (!r.items.length) {
    document.getElementById('rankings-table').innerHTML = '<div class="empty">No rank snapshots yet. Run <code>npm run rank-tracker</code> to generate one.</div>';
    return;
  }

  const note = r.latestDate ? r.latestDate + (r.previousDate ? ' vs ' + r.previousDate : '') : '';
  document.getElementById('rank-note').textContent = note;

  const tierBadge = function(t) {
    if (t === 'page1')     return badge('page1', 'Page 1');
    if (t === 'quickWins') return badge('quickwins', 'Quick Win');
    if (t === 'needsWork') return badge('needswork-rank', 'Needs Work');
    return badge('notranking', 'Not Ranking');
  };

  const changeHtml = function(x) {
    if (x.change == null) return '<span class="muted">&#8212;</span>';
    if (x.change > 0) return '<span class="change change-up">&#8593; ' + x.change + '</span>';
    if (x.change < 0) return '<span class="change change-down">&#8595; ' + Math.abs(x.change) + '</span>';
    return '<span class="change change-flat">&#8594; 0</span>';
  };

  // ── apply search ──
  const q = rankSearch.toLowerCase();
  let items = q ? r.items.filter(function(x) { return x.keyword.toLowerCase().indexOf(q) !== -1; }) : r.items.slice();

  // ── apply filters ──
  if (rankFilters.position !== 'all') {
    items = items.filter(function(x) {
      if (rankFilters.position === 'top3')      return x.position != null && x.position <= 3;
      if (rankFilters.position === 'top10')     return x.position != null && x.position <= 10;
      if (rankFilters.position === 'top20')     return x.position != null && x.position <= 20;
      if (rankFilters.position === 'beyond20')  return x.position != null && x.position > 20;
      if (rankFilters.position === 'norank')    return x.position == null;
      return true;
    });
  }
  if (rankFilters.change !== 'all') {
    items = items.filter(function(x) {
      if (rankFilters.change === 'improved')  return x.change != null && x.change > 0;
      if (rankFilters.change === 'declined')  return x.change != null && x.change < 0;
      if (rankFilters.change === 'flat')      return x.change != null && x.change === 0;
      if (rankFilters.change === 'new')       return x.change == null && x.position != null;
      return true;
    });
  }
  if (rankFilters.volume !== 'all') {
    items = items.filter(function(x) {
      if (rankFilters.volume === 'high') return (x.volume || 0) >= 1000;
      if (rankFilters.volume === 'med')  return (x.volume || 0) >= 100 && (x.volume || 0) < 1000;
      if (rankFilters.volume === 'low')  return (x.volume || 0) < 100;
      return true;
    });
  }
  if (rankFilters.tier !== 'all') {
    items = items.filter(function(x) { return x.tier === rankFilters.tier; });
  }

  // ── apply sort ──
  if (rankSort.col) {
    const dir = rankSort.dir === 'asc' ? 1 : -1;
    items = items.slice().sort(function(a, b) {
      if (rankSort.col === 'keyword') {
        return dir * a.keyword.localeCompare(b.keyword);
      }
      if (rankSort.col === 'position') {
        if (a.position == null && b.position == null) return 0;
        if (a.position == null) return 1;
        if (b.position == null) return -1;
        return dir * (a.position - b.position);
      }
      if (rankSort.col === 'change') {
        const ac = a.change != null ? a.change : -999;
        const bc = b.change != null ? b.change : -999;
        return dir * (ac - bc);
      }
      if (rankSort.col === 'volume') {
        return dir * ((a.volume || 0) - (b.volume || 0));
      }
      if (rankSort.col === 'tier') {
        const order = { page1: 0, quickWins: 1, needsWork: 2, notRanking: 3 };
        return dir * ((order[a.tier] || 0) - (order[b.tier] || 0));
      }
      return 0;
    });
  }

  // ── paginate ──
  const totalPages = Math.max(1, Math.ceil(items.length / RANK_PAGE_SIZE));
  rankPage = Math.max(0, Math.min(rankPage, totalPages - 1));
  const pageItems = items.slice(rankPage * RANK_PAGE_SIZE, (rankPage + 1) * RANK_PAGE_SIZE);

  // ── active filter chips ──
  const chipLabels = {
    position: { top3: 'Pos: Top 3', top10: 'Pos: Top 10', top20: 'Pos: Top 20', beyond20: 'Pos: 20+', norank: 'Pos: Not ranking' },
    change:   { improved: 'Change: Improved', declined: 'Change: Declined', flat: 'Change: Flat', new: 'Change: New' },
    volume:   { high: 'Vol: High', med: 'Vol: Med', low: 'Vol: Low' },
    tier:     { page1: 'Tier: Page 1', quickWins: 'Tier: Quick Win', needsWork: 'Tier: Needs Work', notRanking: 'Tier: Not Ranking' },
  };
  const chips = Object.keys(rankFilters).filter(function(k) { return rankFilters[k] !== 'all'; }).map(function(k) {
    const label = (chipLabels[k] || {})[rankFilters[k]] || rankFilters[k];
    return '<span class="filter-chip">' + label + '<span class="filter-chip-x" onclick="setRankFilter(\'' + k + '\',\'all\')">&#215;</span></span>';
  }).join('');
  const chipsHtml = chips ? '<div class="filter-chips">' + chips + '</div>' : '';

  // ── search bar ──
  const searchBar = '<div style="margin-bottom:8px"><input id="rank-search-input" type="text" placeholder="Search keywords..." value="' + esc(rankSearch) + '" oninput="rankSearch=this.value;rankPage=0;renderRankings(data)" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;box-sizing:border-box" /></div>';

  // ── column header builder ──
  function thHtml(label, sortCol, filterKey, filterOpts) {
    const sortInd = rankSort.col === sortCol ? (rankSort.dir === 'asc' ? ' &#8593;' : ' &#8595;') : '';
    const sortAttr = sortCol ? ' class="th-sort" onclick="sortRankBy(\'' + sortCol + '\')"' : '';
    let filterHtml = '';
    if (filterKey) {
      const isActive = rankFilters[filterKey] !== 'all';
      const opts = filterOpts.map(function(o) {
        const sel = rankFilters[filterKey] === o.val ? ' selected' : '';
        return '<div class="th-filter-opt' + sel + '" onclick="event.stopPropagation();setRankFilter(\'' + filterKey + '\',\'' + o.val + '\')">' + o.label + '</div>';
      }).join('');
      filterHtml = '<div class="th-filter-wrap">' +
        '<span class="th-filter-btn' + (isActive ? ' active' : '') + '" onclick="event.stopPropagation();toggleRankMenu(\'' + filterKey + '\')">&#9660;</span>' +
        '<div id="rmenu-' + filterKey + '" class="th-filter-menu">' + opts + '</div>' +
        '</div>';
    }
    return '<th><div class="th-inner"><span' + sortAttr + '>' + label + sortInd + '</span>' + filterHtml + '</div></th>';
  }

  const posOpts = [
    { val: 'all', label: 'All' }, { val: 'top3', label: 'Top 3' }, { val: 'top10', label: 'Top 10' },
    { val: 'top20', label: 'Top 20' }, { val: 'beyond20', label: '20+' }, { val: 'norank', label: 'Not ranking' },
  ];
  const chgOpts = [
    { val: 'all', label: 'All' }, { val: 'improved', label: 'Improved' },
    { val: 'declined', label: 'Declined' }, { val: 'flat', label: 'No change' }, { val: 'new', label: 'New entry' },
  ];
  const volOpts = [
    { val: 'all', label: 'All' }, { val: 'high', label: 'High (1k+)' },
    { val: 'med', label: 'Med (100-999)' }, { val: 'low', label: 'Low (<100)' },
  ];
  const tierOpts = [
    { val: 'all', label: 'All' }, { val: 'page1', label: 'Page 1' },
    { val: 'quickWins', label: 'Quick Win' }, { val: 'needsWork', label: 'Needs Work' }, { val: 'notRanking', label: 'Not Ranking' },
  ];

  const rows = pageItems.map(function(x, i) {
    const globalIdx = r.items.indexOf(x);
    const idxRef = globalIdx !== -1 ? globalIdx : rankPage * RANK_PAGE_SIZE + i;
    return '<tr style="cursor:pointer" onclick="openKeywordCard(data.rankings.items[' + idxRef + '])">' +
      '<td>' + esc(x.keyword) + (x.tracked ? ' <span class="muted" style="font-size:10px">&#9679;</span>' : '') + '</td>' +
      '<td class="nowrap"><span class="pos">' + (x.position != null ? '#' + x.position : '&#8212;') + '</span></td>' +
      '<td class="nowrap">' + changeHtml(x) + (x.previousPosition != null ? '<span class="muted" style="font-size:11px;margin-left:4px">was #' + x.previousPosition + '</span>' : '') + '</td>' +
      '<td class="nowrap muted">' + fmtNum(x.volume) + '</td>' +
      '<td>' + tierBadge(x.tier) + '</td>' +
      '</tr>';
  }).join('');

  const pagination =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:13px;">' +
    '<button onclick="rankPage--;renderRankings(data)" ' + (rankPage === 0 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">&#8592; Prev</button>' +
    '<span class="muted">Page ' + (rankPage + 1) + ' of ' + totalPages + ' (' + items.length + ' keywords)</span>' +
    '<button onclick="rankPage++;renderRankings(data)" ' + (rankPage >= totalPages - 1 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">Next &#8594;</button>' +
    '</div>';

  document.getElementById('rankings-table').innerHTML =
    searchBar + chipsHtml +
    '<table><thead><tr>' +
    thHtml('Keyword', 'keyword', null, []) +
    thHtml('Position', 'position', 'position', posOpts) +
    thHtml('Change', 'change', 'change', chgOpts) +
    thHtml('Volume', 'volume', 'volume', volOpts) +
    thHtml('Tier', 'tier', 'tier', tierOpts) +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + pagination;

  // Restore search input focus if it was focused before re-render
  const inp = document.getElementById('rank-search-input');
  if (inp && document.activeElement === document.body) inp; // no auto-focus on re-render
}
```

---

## Task 7: Add `openImageModal`/`closeImageModal` + rewrite `renderPosts`

- [ ] **Step 1: Add image modal globals and posts pagination state before `renderPosts`**

Find:
```js
function renderPosts(d) {
```

Insert immediately before it:
```js
let postsPage = 0;
const POSTS_PAGE_SIZE = 10;

function openImageModal(src) {
  const ov = document.createElement('div');
  ov.id = 'img-modal-overlay';
  ov.onclick = closeImageModal;
  const img = document.createElement('img');
  img.src = src;
  img.onclick = function(e) { e.stopPropagation(); };
  ov.appendChild(img);
  document.body.appendChild(ov);
  document.addEventListener('keydown', _imgModalKey);
}
function closeImageModal() {
  const ov = document.getElementById('img-modal-overlay');
  if (ov) ov.remove();
  document.removeEventListener('keydown', _imgModalKey);
}
function _imgModalKey(e) {
  if (e.key === 'Escape') closeImageModal();
}

```

- [ ] **Step 2: Replace `renderPosts` function**

Find (lines 1389–1426):
```js
function renderPosts(d) {
  if (!d.posts.length) {
    document.getElementById('posts-table').innerHTML = '<div class="empty">No posts found.</div>';
    return;
  }
  document.getElementById('posts-note').textContent = d.posts.length + ' posts';

  const rows = d.posts.map(p => {
    const titleHtml = p.shopifyUrl
      ? '<a class="link" href="' + p.shopifyUrl + '" target="_blank">' + esc(p.title || p.slug) + '</a>'
      : esc(p.title || p.slug);
    const editorHtml = p.editorVerdict === 'Approved'    ? badge('approved', '✓ Approved')
                     : p.editorVerdict === 'Needs Work'  ? badge('needswork', '⚠ Needs Work')
                     : '<span class="muted">—</span>';
    const linksHtml = p.brokenLinks > 0
      ? '<span style="color:var(--red);font-weight:600">' + p.brokenLinks + ' broken</span>'
      : '<span class="muted">—</span>';
    const imgHtml = p.hasImage ? '🖼' : '<span class="muted">—</span>';
    const dateHtml = p.status === 'scheduled' && p.publishAt
      ? fmtDate(p.publishAt)
      : fmtDate(p.uploadedAt);

    return '<tr>' +
      '<td>' + titleHtml + '</td>' +
      '<td class="muted">' + esc(p.keyword || '—') + '</td>' +
      '<td>' + statusBadge(p.status) + '</td>' +
      '<td class="nowrap muted">' + dateHtml + '</td>' +
      '<td>' + editorHtml + '</td>' +
      '<td class="nowrap">' + linksHtml + '</td>' +
      '<td style="text-align:center">' + imgHtml + '</td>' +
      '</tr>';
  }).join('');

  document.getElementById('posts-table').innerHTML =
    '<table><thead><tr>' +
    '<th>Title</th><th>Keyword</th><th>Status</th><th>Date</th><th>Editor</th><th>Links</th><th>Image</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}
```

Replace with:
```js
function renderPosts(d) {
  if (!d.posts.length) {
    document.getElementById('posts-table').innerHTML = '<div class="empty">No posts found.</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(d.posts.length / POSTS_PAGE_SIZE));
  postsPage = Math.max(0, Math.min(postsPage, totalPages - 1));
  document.getElementById('posts-note').textContent = d.posts.length + ' posts';

  const pageItems = d.posts.slice(postsPage * POSTS_PAGE_SIZE, (postsPage + 1) * POSTS_PAGE_SIZE);

  const rows = pageItems.map(function(p) {
    const titleHtml = p.shopifyUrl
      ? '<a class="link" href="' + p.shopifyUrl + '" target="_blank">' + esc(p.title || p.slug) + '</a>'
      : esc(p.title || p.slug);
    const editorHtml = p.editorVerdict === 'Approved'
      ? badge('approved', '&#10003; Approved')
      : p.editorVerdict === 'Needs Work'
      ? badge('needswork', '&#9888; Needs Work')
      : '<span class="muted">&#8212;</span>';
    const linksHtml = p.brokenLinks > 0
      ? '<span style="color:var(--red);font-weight:600">' + p.brokenLinks + ' broken</span>'
      : '<span class="muted">&#8212;</span>';
    let imgHtml;
    if (p.hasImage) {
      const imgSrc = p.shopifyImageUrl || ('/images/' + p.slug);
      imgHtml = '<a href="#" onclick="event.preventDefault();openImageModal(\'' + imgSrc + '\')" title="View image" style="font-size:16px;text-decoration:none">&#128444;</a>';
    } else {
      imgHtml = '<span class="muted">&#8212;</span>';
    }
    const dateHtml = p.status === 'scheduled' && p.publishAt
      ? fmtDate(p.publishAt)
      : fmtDate(p.uploadedAt);

    return '<tr>' +
      '<td>' + titleHtml + '</td>' +
      '<td class="muted">' + esc(p.keyword || '&#8212;') + '</td>' +
      '<td>' + statusBadge(p.status) + '</td>' +
      '<td class="nowrap muted">' + dateHtml + '</td>' +
      '<td>' + editorHtml + '</td>' +
      '<td class="nowrap">' + linksHtml + '</td>' +
      '<td style="text-align:center">' + imgHtml + '</td>' +
      '</tr>';
  }).join('');

  const pagination =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:13px;">' +
    '<button onclick="postsPage--;renderPosts(data)" ' + (postsPage === 0 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">&#8592; Prev</button>' +
    '<span class="muted">Page ' + (postsPage + 1) + ' of ' + totalPages + ' (' + d.posts.length + ' posts)</span>' +
    '<button onclick="postsPage++;renderPosts(data)" ' + (postsPage >= totalPages - 1 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">Next &#8594;</button>' +
    '</div>';

  document.getElementById('posts-table').innerHTML =
    '<table><thead><tr>' +
    '<th>Title</th><th>Keyword</th><th>Status</th><th>Date</th><th>Editor</th><th>Links</th><th>Image</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + pagination;
}
```

---

## Task 8: Test locally and commit

- [ ] **Step 1: Start the dashboard locally**

```bash
node agents/dashboard/index.js
```

Expected output:
```
SEO Dashboard — <site name>
  http://localhost:4242
  Auto-refreshes every 60m. Ctrl+C to stop.
```

- [ ] **Step 2: Verify each changed section**

Open `http://localhost:4242` and confirm:

1. **Content Pipeline** — kanban columns scroll within themselves when they have more than ~10 items; no "+N more" text
2. **Keyword Rankings** — shows 10 rows; search bar at top filters by keyword; column headers have sort arrows + ▾ filter buttons; filter dropdowns open/close; active filters show as chips with × dismiss; pagination shows correct counts
3. **Posts** — shows 10 rows; Prev/Next pagination works; Image column shows 🖼 link for posts with images; clicking the icon opens a full-screen lightbox; clicking outside or pressing Escape closes it

- [ ] **Step 3: Check for console errors**

Open browser DevTools console. Should be no errors on page load or interaction.

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add scrollable kanban, rankings sort/filter/search, posts pagination + image lightbox"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Pipeline: 10 items then scroll | Task 4 (CSS max-height) + Task 5 (remove slice cap) |
| Rankings: 10 rows with pagination | Task 6 (RANK_PAGE_SIZE = 10) |
| Rankings: column heading sort | Task 6 (sortRankBy + thHtml) |
| Rankings: column heading filter dropdown | Task 6 (toggleRankMenu + setRankFilter + thHtml) |
| Rankings: search bar | Task 6 (searchBar + rankSearch state) |
| Posts: 10 items with pagination | Task 7 (POSTS_PAGE_SIZE + pagination bar) |
| Posts: image links to popup | Task 7 (openImageModal + /images/:slug route in Task 3) |

**Escape sequence audit:**
- All `→`, `←`, `↑`, `↓`, `—`, `✓`, `⚠`, `●`, `🖼` replaced with HTML entities (`&#8594;`, `&#8592;`, `&#8593;`, `&#8595;`, `&#8212;`, `&#10003;`, `&#9888;`, `&#9679;`, `&#128444;`) — safe inside browser JS strings.
- No `\n`, `\t`, `\r` inside any string literal in the new code.
- No `\s`, `\t`, `\r`, `\n` in any regex pattern.

**Type consistency:** `postsPage` used in `renderPosts` and in the pagination buttons' `onclick` attrs — consistent. `rankSearch`, `rankSort`, `rankFilters`, `rankPage` all defined before `renderRankings` and referenced consistently throughout.
