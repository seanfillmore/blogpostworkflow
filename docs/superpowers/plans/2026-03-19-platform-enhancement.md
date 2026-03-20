# Platform Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the dashboard with a Bold & Data-Forward visual theme and add four new backend capabilities: Ahrefs authority panel, rank change alerts, pipeline automation, and meta A/B testing.

**Architecture:** In-place overhaul of `agents/dashboard/index.js` (CSS + HTML generation only, data logic untouched), plus four new agents/scripts following the existing collector pattern. CSS custom properties used as design tokens for future React portability.

**Tech Stack:** Node.js ESM, `node:test` for unit tests, `lib/notify.js` (Resend) for alerts, Shopify REST API for meta A/B testing.

---

## File Map

**Modified:**
- `agents/dashboard/index.js` — CSS design system + hero header + tab-contextual KPIs + SEO Authority panel + CRO tab restyling
- `agents/publisher/index.js` — add `--no-verify` flag + post-publish verifier spawn
- `scripts/setup-cron.sh` — register new cron jobs
- `package.json` — add `test` script

**Created:**
- `agents/rank-alerter/index.js` — GSC snapshot diff → alert report + notify
- `agents/pipeline-scheduler/index.js` — auto-brief scheduler from content calendar
- `agents/meta-ab-tracker/index.js` — weekly A/B CTR tracking + conclusion
- `scripts/create-meta-test.js` — A/B test creation + Shopify metafield write
- `tests/lib/ahrefs-parser.test.js` — unit tests for CSV parsing utility
- `tests/agents/rank-alerter.test.js` — unit tests for GSC diff logic
- `tests/agents/meta-ab-tracker.test.js` — unit tests for CTR delta calculation
- `lib/ahrefs-parser.js` — Ahrefs CSV parsing utility (shared)

---

## Task 1: Test Infrastructure + Ahrefs CSV Parser

**Files:**
- Create: `lib/ahrefs-parser.js`
- Create: `tests/lib/ahrefs-parser.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add test script to package.json**

Open `package.json` and add to the `"scripts"` block:
```json
"test": "node --test tests/**/*.test.js"
```

- [ ] **Step 2: Create `tests/` directory structure**

```bash
mkdir -p tests/lib tests/agents
```

- [ ] **Step 3: Write failing tests for Ahrefs CSV parser**

Create `tests/lib/ahrefs-parser.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAhrefsOverview } from '../../lib/ahrefs-parser.js';

test('parses standard Ahrefs domain overview CSV', () => {
  const csv = `Domain Rating,Backlinks,Referring Domains,Organic Traffic Value\n72,1240,310,45600`;
  const result = parseAhrefsOverview(csv);
  assert.equal(result.domainRating, '72');
  assert.equal(result.backlinks, '1240');
  assert.equal(result.referringDomains, '310');
  assert.equal(result.organicTrafficValue, '45600');
});

test('handles missing columns gracefully', () => {
  const csv = `Domain Rating,Some Other Column\n72,foo`;
  const result = parseAhrefsOverview(csv);
  assert.equal(result.domainRating, '72');
  assert.equal(result.backlinks, null);
  assert.equal(result.referringDomains, null);
  assert.equal(result.organicTrafficValue, null);
});

test('returns null for empty or invalid CSV', () => {
  assert.equal(parseAhrefsOverview(''), null);
  assert.equal(parseAhrefsOverview('just a header\n'), null);
});

test('is case-insensitive for column names', () => {
  const csv = `domain rating,BACKLINKS,referring domains,organic traffic value\n55,800,200,12000`;
  const result = parseAhrefsOverview(csv);
  assert.equal(result.domainRating, '55');
  assert.equal(result.backlinks, '800');
});
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
node --test tests/lib/ahrefs-parser.test.js
```
Expected: `ERR_MODULE_NOT_FOUND` (file doesn't exist yet)

- [ ] **Step 5: Implement `lib/ahrefs-parser.js`**

```js
/**
 * Ahrefs CSV export parser.
 * Reads domain overview metrics from manually-placed CSV exports in data/ahrefs/.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function parseAhrefsOverview(csvText) {
  if (!csvText || !csvText.trim()) return null;
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return null;

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const values  = lines[1].split(',').map(v => v.trim().replace(/"/g, ''));

  const row = {};
  headers.forEach((h, i) => { row[h] = values[i] ?? null; });

  const find = (...keys) => {
    for (const k of keys) {
      const v = row[k.toLowerCase()];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };

  return {
    domainRating:        find('domain rating', 'dr'),
    backlinks:           find('backlinks', 'all backlinks'),
    referringDomains:    find('referring domains', 'ref domains', 'refdomains'),
    organicTrafficValue: find('organic traffic value', 'traffic value'),
  };
}

export function loadLatestAhrefsOverview(dir) {
  if (!existsSync(dir)) return null;
  const csvFiles = readdirSync(dir)
    .filter(f => f.endsWith('.csv'))
    .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!csvFiles.length) return null;
  const text = readFileSync(join(dir, csvFiles[0].f), 'utf8');
  return parseAhrefsOverview(text);
}
```

- [ ] **Step 6: Run tests — confirm they pass**

```bash
node --test tests/lib/ahrefs-parser.test.js
```
Expected: 4 passing

- [ ] **Step 7: Commit**

```bash
git add lib/ahrefs-parser.js tests/lib/ahrefs-parser.test.js package.json
git commit -m "feat: add ahrefs CSV parser lib with node:test suite"
```

---

## Task 2: Dashboard CSS Design System

**Files:**
- Modify: `agents/dashboard/index.js` (CSS block ~lines 432–602)

The CSS block lives inside a template literal in the `generateHTML()` function (search for `<style>`). Replace everything between `<style>` and `</style>` tags with the new design system below.

- [ ] **Step 1: Add Inter font import to `<head>`**

Find the line:
```js
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEO Dashboard</title>
```
Replace with:
```js
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<title>SEO Dashboard</title>
```

- [ ] **Step 2: Replace the entire CSS block**

Find `<style>` through `</style>` and replace with:

```css
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:      #f8fafc;
    --surface: #ffffff;
    --border:  #e2e8f0;
    --text:    #0f172a;
    --muted:   #94a3b8;
    --green:   #10b981;
    --amber:   #f59e0b;
    --red:     #ef4444;
    --purple:  #8b5cf6;
    --sky:     #38bdf8;
    --orange:  #fb923c;
    --indigo:  #6366f1;
    --radius:  10px;
    --shadow:  0 1px 3px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.04);
  }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.5; }

  /* ── hero header ── */
  .hero { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 60%, #4338ca 100%); padding: 14px 24px 16px; position: sticky; top: 0; z-index: 10; }
  .hero-top { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .hero-logo { width: 28px; height: 28px; border-radius: 8px; background: rgba(255,255,255,.15); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; color: white; flex-shrink: 0; }
  .hero-name { color: white; font-size: 13px; font-weight: 700; line-height: 1.2; }
  .hero-url  { color: rgba(255,255,255,.4); font-size: 10px; }
  .tab-pills { display: flex; gap: 2px; background: rgba(0,0,0,.2); border-radius: 999px; padding: 3px; margin-left: 12px; }
  .tab-pill  { padding: 4px 14px; font-size: 11px; font-weight: 600; color: rgba(255,255,255,.55); background: none; border: none; border-radius: 999px; cursor: pointer; transition: all .15s; }
  .tab-pill.active { background: white; color: #312e81; }
  .hero-meta { margin-left: auto; color: rgba(255,255,255,.4); font-size: 11px; }
  .hero-kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .hero-kpi  { background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,.08); border-radius: 8px; padding: 10px 12px; }
  .hero-kpi-value { font-size: 20px; font-weight: 800; line-height: 1; color: white; }
  .hero-kpi-label { font-size: 9px; color: rgba(255,255,255,.45); margin-top: 3px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; }
  .refresh-btn { padding: 4px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.1); cursor: pointer; font-size: 12px; color: rgba(255,255,255,.7); font-family: inherit; transition: all .15s; }
  .refresh-btn:hover { background: rgba(255,255,255,.2); color: white; }

  /* ── layout ── */
  main { max-width: 1400px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }

  /* ── cards ── */
  .card { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); border: 1px solid var(--border); }
  .card-header { padding: 14px 18px 10px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .card-header h2 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .card-header.accent-green  { border-left: 3px solid var(--green); }
  .card-header.accent-sky    { border-left: 3px solid var(--sky); }
  .card-header.accent-purple { border-left: 3px solid var(--purple); }
  .card-header.accent-orange { border-left: 3px solid var(--orange); }
  .card-header.accent-amber  { border-left: 3px solid var(--amber); }
  .card-body { padding: 16px 18px; }

  /* ── pipeline kanban ── */
  .kanban { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
  .kanban-col { border-radius: 8px; border: 1px solid var(--border); overflow: hidden; }
  .kanban-head { padding: 8px 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; justify-content: space-between; }
  .kanban-count { font-size: 22px; font-weight: 800; padding: 4px 12px 8px; }
  .kanban-items { padding: 0 8px 8px; display: grid; gap: 4px; }
  .kanban-item { font-size: 11px; padding: 5px 7px; border-radius: 5px; line-height: 1.35; }
  .kanban-item .kw  { font-weight: 500; }
  .kanban-item .vol { color: var(--muted); font-size: 10px; }
  .kanban-item .pub-date-scheduled { color: var(--red);   font-size: 10px; font-weight: 600; }
  .kanban-item .pub-date-published  { color: var(--green); font-size: 10px; font-weight: 600; }
  .col-published .kanban-head { background: #f0fdf4; color: var(--green); }
  .col-published .kanban-item { background: #f0fdf4; }
  .col-scheduled .kanban-head { background: #eef2ff; color: var(--indigo); }
  .col-scheduled .kanban-item { background: #eef2ff; }
  .col-draft     .kanban-head { background: #fffbeb; color: var(--amber); }
  .col-draft     .kanban-item { background: #fffbeb; }
  .col-written   .kanban-head { background: #f5f3ff; color: var(--purple); }
  .col-written   .kanban-item { background: #f5f3ff; }
  .col-briefed   .kanban-head { background: #ecfeff; color: #0891b2; }
  .col-briefed   .kanban-item { background: #ecfeff; }
  .col-pending   .kanban-head { background: #f8fafc; color: var(--muted); }
  .col-pending   .kanban-item { background: #f8fafc; }

  /* ── tables ── */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  tbody tr:hover { background: #f8fafc; }
  tbody tr:last-child td { border-bottom: none; }

  /* ── badges ── */
  .badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px; display: inline-block; }
  .badge-published { background: #dcfce7; color: var(--green); }
  .badge-scheduled { background: #e0e7ff; color: var(--indigo); }
  .badge-draft     { background: #fef3c7; color: var(--amber); }
  .badge-written   { background: #ede9fe; color: var(--purple); }
  .badge-briefed   { background: #cffafe; color: #0891b2; }
  .badge-pending   { background: #f3f4f6; color: var(--muted); }
  .badge-local     { background: #f3f4f6; color: var(--muted); }
  .badge-page1     { background: #dcfce7; color: var(--green); }
  .badge-quickwins { background: #e0e7ff; color: var(--indigo); }
  .badge-needswork-rank { background: #fef3c7; color: var(--amber); }
  .badge-notranking { background: #f3f4f6; color: var(--muted); }

  /* ── rank change ── */
  .change-up   { color: var(--green); font-weight: 600; }
  .change-down { color: var(--red);   font-weight: 600; }
  .change-flat { color: var(--muted); }

  /* ── tab panels ── */
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* ── rank alerts ── */
  .alert-banner { border-radius: var(--radius); padding: 12px 18px; font-size: 13px; display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .alert-banner.alert-red   { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
  .alert-banner.alert-green { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
  .alert-banner-dismiss { margin-left: auto; font-size: 11px; opacity: .6; }

  /* ── cro ── */
  .cro-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .cro-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .cro-table td { padding: 6px 0; border-bottom: 1px solid var(--border); }
  .cro-table td:first-child { color: var(--muted); }
  .cro-table td:last-child { text-align: right; font-weight: 500; }
  .cro-sub { font-size: 10px; color: var(--muted); }
  .cro-delta { font-size: 11px; margin-top: 3px; font-weight: 500; display: block; }
  .cro-delta.up   { color: var(--green); }
  .cro-delta.down { color: var(--red); }
  .cro-delta.flat { color: var(--muted); }
  .brief-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; }
  .brief-item { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 12px; }
  .brief-item-title { font-size: 11px; font-weight: 700; color: #c2410c; margin-bottom: 6px; }
  .brief-item-body  { font-size: 11px; color: #78350f; line-height: 1.5; }
  .filter-bar { display: flex; gap: 6px; }
  .filter-btn { padding: 4px 12px; font-size: 11px; font-weight: 600; color: var(--muted); background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.15); border-radius: 999px; cursor: pointer; color: rgba(255,255,255,.6); font-family: inherit; transition: all .15s; }
  .filter-btn:hover { color: white; border-color: rgba(255,255,255,.3); }
  .filter-btn.active { background: rgba(255,255,255,.2); color: white; border-color: rgba(255,255,255,.3); }
  .gsc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .gsc-table th { text-align: left; font-size: 11px; color: var(--muted); font-weight: 500; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .gsc-table td { padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .gsc-table td:not(:first-child) { text-align: right; }
  .gsc-summary { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
  .gsc-stat { display: flex; flex-direction: column; }
  .gsc-stat-value { font-size: 20px; font-weight: 700; }
  .gsc-stat-label { font-size: 11px; color: var(--muted); margin-top: 2px; }

  /* ── seo authority ── */
  .authority-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .authority-stat { padding: 14px 16px; border-left: 3px solid var(--indigo); }
  .authority-stat-value { font-size: 24px; font-weight: 800; color: var(--text); line-height: 1; }
  .authority-stat-label { font-size: 11px; color: var(--muted); margin-top: 3px; text-transform: uppercase; letter-spacing: .05em; font-weight: 500; }
  .card-header.accent-indigo { border-left: 3px solid var(--indigo); }

  /* ── data needed ── */
  .data-needed { background: #fffbeb; border: 1px solid #fde68a; border-radius: var(--radius); padding: 14px 18px; font-size: 13px; color: #92400e; }
  .data-needed strong { display: block; margin-bottom: 4px; font-weight: 700; }

  /* ── active tests ── */
  .test-pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .test-pill { display: inline-flex; align-items: center; gap: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; font-size: 11px; }
  .test-pill .tp-slug { font-weight: 600; color: var(--text); }
  .test-pill .tp-day  { color: var(--muted); }
  .test-pill .tp-delta-pos { color: var(--green); font-weight: 600; }
  .test-pill .tp-delta-neg { color: var(--red);   font-weight: 600; }
  .test-pill .tp-delta-flat { color: var(--muted); }

  /* ── misc ── */
  .link { color: var(--indigo); text-decoration: none; }
  .link:hover { text-decoration: underline; }
  .muted { color: var(--muted); }
  .empty-state { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
  .section-note { font-size: 11px; color: var(--muted); }
</style>
```

- [ ] **Step 3: Start the dashboard and visually confirm CSS loads**

```bash
node agents/dashboard/index.js --open
```
Expected: Dashboard opens, page background is light gray (#f8fafc), no layout breakage. Font may still be system font until Inter loads.

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: dashboard CSS design system — Bold & Data-Forward theme"
```

---

## Task 3: Dashboard Hero Header + Tab-Contextual KPIs

**Files:**
- Modify: `agents/dashboard/index.js` (HTML structure + `switchTab` JS)

The `generateHTML()` function builds the page HTML. Find the `<header>` tag and the `<div class="tab-nav">` and replace them with the new hero header structure. Also replace the `switchTab` JS function.

- [ ] **Step 1: Replace the `<header>` block**

Find:
```js
<body>
<header>
  <h1 id="site-name">SEO Dashboard</h1>
  <span class="header-meta">Updated <span id="updated-at">—</span> &nbsp;|&nbsp; Auto-refresh every 60s</span>
  <button class="refresh-btn" onclick="loadData()"><span id="spin-icon"></span> Refresh</button>
</header>

<main>
<div class="tab-nav">
  <button class="tab-btn active" onclick="switchTab('seo', this)">SEO</button>
  <button class="tab-btn" onclick="switchTab('cro', this)">CRO</button>
</div>
```

Replace with (note: `${config.name}` and `${config.url}` are already available in the template):
```js
<body>
<header class="hero">
  <div class="hero-top">
    <div class="hero-logo" id="hero-logo"></div>
    <div>
      <div class="hero-name" id="site-name"></div>
      <div class="hero-url" id="site-url"></div>
    </div>
    <div class="tab-pills">
      <button class="tab-pill active" onclick="switchTab('seo',this)">SEO</button>
      <button class="tab-pill" onclick="switchTab('cro',this)" id="pill-cro">CRO</button>
      <button class="tab-pill" onclick="switchTab('ads',this)" id="pill-ads" style="display:none">Ads</button>
    </div>
    <div id="cro-filter-bar" style="display:none">
      <div class="filter-bar">
        <button class="filter-btn active" onclick="setCroFilter('today',this)">Today</button>
        <button class="filter-btn" onclick="setCroFilter('yesterday',this)">Yesterday</button>
        <button class="filter-btn" onclick="setCroFilter('7days',this)">7 Days</button>
        <button class="filter-btn" onclick="setCroFilter('30days',this)">30 Days</button>
      </div>
    </div>
    <span class="hero-meta">Updated <span id="updated-at">—</span></span>
    <button class="refresh-btn" onclick="loadData()">↻ Refresh</button>
  </div>
  <div class="hero-kpis" id="hero-kpis"></div>
</header>

<main>
```

- [ ] **Step 2: Remove the old filter bar from the CRO tab panel**

Find inside the CRO tab panel:
```js
<div id="tab-cro" class="tab-panel">
  <div class="filter-bar">
    <button class="filter-btn active" onclick="setCroFilter('today',this)">Today</button>
    <button class="filter-btn" onclick="setCroFilter('yesterday',this)">Yesterday</button>
    <button class="filter-btn" onclick="setCroFilter('7days',this)">Last 7 Days</button>
    <button class="filter-btn" onclick="setCroFilter('30days',this)">Last 30 Days</button>
  </div>
  <div id="cro-kpi-strip" style="margin-bottom:16px"></div>
```

Replace with (filter bar moved to hero, old KPI strip div retained but rendered empty):
```js
<div id="tab-cro" class="tab-panel">
  <div id="cro-kpi-strip" style="display:none"></div>
```

- [ ] **Step 3: Replace the `switchTab` JavaScript function**

Find:
```js
function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}
```

Replace with:
```js
let activeTab = 'seo';

function switchTab(name, btn) {
  activeTab = name;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-pill').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  // Show/hide CRO date filter
  document.getElementById('cro-filter-bar').style.display = name === 'cro' ? '' : 'none';
  // Update hero KPIs for this tab
  if (data) renderHeroKpis(data);
}

function renderHeroKpis(d) {
  const seoKpis = buildSeoKpis(d);
  const croKpis = buildCroKpis(d);
  const adsKpis = buildAdsKpis(d);
  const kpis = activeTab === 'cro' ? croKpis : activeTab === 'ads' ? adsKpis : seoKpis;
  document.getElementById('hero-kpis').innerHTML = kpis.map(k =>
    '<div class="hero-kpi">' +
    '<div class="hero-kpi-value" style="color:' + k.color + '">' + k.value + '</div>' +
    '<div class="hero-kpi-label">' + k.label + '</div>' +
    '</div>'
  ).join('');
}

function buildSeoKpis(d) {
  const c = d.pipeline.counts;
  const r = d.rankings;
  const page1 = r.summary.page1;
  const rankItems = r.items.filter(x => x.change != null);
  const avgChange = rankItems.length
    ? (rankItems.reduce((s, x) => s + x.change, 0) / rankItems.length).toFixed(1)
    : null;
  const gscClicks = d.gscSEO?.summary?.clicks ?? null;
  return [
    { label: 'Published',   value: c.published || 0,                                          color: '#10b981' },
    { label: 'Scheduled',   value: c.scheduled  || 0,                                          color: '#818cf8' },
    { label: 'Pg 1 KWs',    value: page1,                                                      color: '#f59e0b' },
    { label: 'Avg Rank Δ',  value: avgChange != null ? (avgChange > 0 ? '+' : '') + avgChange : '—', color: '#c084fc' },
    { label: 'GSC Clicks',  value: gscClicks != null ? gscClicks.toLocaleString() : '—',       color: '#38bdf8' },
  ];
}

function buildCroKpis(d) {
  const cro = d.cro || {};
  const ga4 = cro.ga4All?.[0];
  const sh  = cro.shopifyAll?.[0];
  const cl  = cro.clarityAll?.[0];
  return [
    { label: 'Conv. Rate',  value: ga4?.conversionRate != null ? (ga4.conversionRate * 100).toFixed(1) + '%' : '—', color: '#10b981' },
    { label: 'Avg Order',   value: sh?.orders?.aov != null ? '$' + Math.round(sh.orders.aov) : '—',                  color: '#fb923c' },
    { label: 'Bounce Rate', value: ga4?.bounceRate != null ? (ga4.bounceRate * 100).toFixed(1) + '%' : '—',           color: '#ef4444' },
    { label: 'Sessions',    value: cl?.sessions?.real ?? ga4?.sessions ?? '—',                                        color: '#38bdf8' },
    { label: 'Cart Abandon',value: sh?.cartAbandonmentRate != null ? (sh.cartAbandonmentRate * 100).toFixed(1) + '%' : '—', color: '#f59e0b' },
  ];
}

function buildAdsKpis(d) {
  const snap = d.googleAdsAll?.[0];
  return [
    { label: 'Daily Spend',  value: snap?.cost_micros != null ? '$' + (snap.cost_micros / 1e6).toFixed(2) : '—', color: '#fb923c' },
    { label: 'Impressions',  value: snap?.impressions != null ? snap.impressions.toLocaleString() : '—',          color: '#38bdf8' },
    { label: 'Clicks',       value: snap?.clicks != null ? snap.clicks.toLocaleString() : '—',                    color: '#818cf8' },
    { label: 'CTR',          value: snap?.ctr != null ? (snap.ctr * 100).toFixed(2) + '%' : '—',                  color: '#f59e0b' },
    { label: 'ROAS',         value: snap?.roas != null ? snap.roas.toFixed(2) + 'x' : '—',                        color: '#10b981' },
  ];
}
```

- [ ] **Step 4: Populate hero logo + site name on load**

Find the `loadData()` function and inside the success path, add:
```js
// Populate hero branding
const nameEl = document.getElementById('site-name');
const urlEl  = document.getElementById('site-url');
const logoEl = document.getElementById('hero-logo');
if (nameEl && d.config) {
  nameEl.textContent = d.config.name || 'SEO Dashboard';
  urlEl.textContent  = d.config.url  || '';
  logoEl.textContent = (d.config.name || 'S').charAt(0).toUpperCase();
}
// Show ads tab pill if data present
if (d.googleAdsAll?.length) document.getElementById('pill-ads').style.display = '';
// Render hero KPIs
renderHeroKpis(d);
```

- [ ] **Step 5: Expose config in the data payload**

In the server-side `parseDashboardData()` (or equivalent data assembly function), add:
```js
config: { name: config.name, url: config.url || '' },
```
to the returned object so it's accessible on the client.

- [ ] **Step 6: Remove the old `renderMetrics` call and its DOM target**

The old `<div class="metrics" id="metrics">` in the SEO tab is no longer needed (KPIs now live in the hero). Remove that div from the HTML and remove the `renderMetrics(d)` call from `loadData()`.

- [ ] **Step 7: Start dashboard and confirm**

```bash
node agents/dashboard/index.js --open
```
Expected: Deep indigo gradient hero header with logo initial, site name, pill tabs, and 5 KPI cards. Switching tabs updates the KPI cards. CRO date filter appears in hero when CRO tab is active.

- [ ] **Step 8: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: dashboard hero header with tab-contextual KPI cards"
```

---

## Task 4: SEO Authority Panel + Rank Alert Banner

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Load Ahrefs data server-side**

In the data-loading section near the top of `index.js` (where other `POSTS_DIR`, `SNAPSHOTS_DIR` etc. paths are defined), add:
```js
import { loadLatestAhrefsOverview } from '../../lib/ahrefs-parser.js';
const AHREFS_DIR      = join(ROOT, 'data', 'ahrefs');
const RANK_ALERTS_DIR = join(ROOT, 'data', 'reports', 'rank-alerts');
const ALERTS_VIEWED   = join(RANK_ALERTS_DIR, '.last-viewed');
```

In the `/data` route handler where data is assembled, add:
```js
// Ahrefs authority
const ahrefsData = loadLatestAhrefsOverview(AHREFS_DIR);

// Rank alerts
let rankAlert = null;
if (existsSync(RANK_ALERTS_DIR)) {
  const alertFiles = readdirSync(RANK_ALERTS_DIR)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .sort().reverse();
  if (alertFiles.length) {
    const latestAlert = alertFiles[0];
    const alertMtime  = statSync(join(RANK_ALERTS_DIR, latestAlert)).mtimeMs;
    const viewedMtime = existsSync(ALERTS_VIEWED) ? statSync(ALERTS_VIEWED).mtimeMs : 0;
    if (alertMtime > viewedMtime) {
      const content = readFileSync(join(RANK_ALERTS_DIR, latestAlert), 'utf8');
      const drops = (content.match(/🔻/g) || []).length;
      const gains = (content.match(/🚀/g) || []).length;
      rankAlert = { file: latestAlert, drops, gains, path: join(RANK_ALERTS_DIR, latestAlert) };
    }
  }
}
```

Include `ahrefsData` and `rankAlert` in the JSON response.

- [ ] **Step 2: Add a `/dismiss-alert` POST route**

After the `/data` route handler:
```js
if (req.method === 'POST' && req.url === '/dismiss-alert') {
  if (!checkAuth(req, res)) return;
  mkdirSync(RANK_ALERTS_DIR, { recursive: true });
  writeFileSync(ALERTS_VIEWED, new Date().toISOString());
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  return;
}
```

- [ ] **Step 3: Add `renderSEOAuthorityPanel` client-side function**

In the `<script>` block, add:
```js
function renderSEOAuthorityPanel(ahrefs) {
  const el = document.getElementById('seo-authority-panel');
  if (!el) return;
  if (!ahrefs) {
    el.innerHTML = '<div class="data-needed"><strong>⚠ SEO Authority Data Needed</strong>Download Ahrefs domain overview export and place in <code>data/ahrefs/</code></div>';
    return;
  }
  const fmt = v => v != null && v !== '' ? Number(v).toLocaleString() : '—';
  const fmtDr = v => v != null && v !== '' ? v : '—';
  const fmtVal = v => v != null && v !== '' ? '$' + (Number(v) / 100).toLocaleString() : '—';
  el.innerHTML =
    '<div class="authority-row">' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmtDr(ahrefs.domainRating) + '</div><div class="authority-stat-label">Domain Rating</div></div>' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmt(ahrefs.backlinks) + '</div><div class="authority-stat-label">Backlinks</div></div>' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmt(ahrefs.referringDomains) + '</div><div class="authority-stat-label">Referring Domains</div></div>' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmtVal(ahrefs.organicTrafficValue) + '</div><div class="authority-stat-label">Organic Traffic Value</div></div>' +
    '</div>';
}

function renderRankAlertBanner(alert) {
  const el = document.getElementById('rank-alert-banner');
  if (!el) return;
  if (!alert) { el.style.display = 'none'; return; }
  const isNeg = alert.drops > alert.gains;
  el.className = 'alert-banner ' + (isNeg ? 'alert-red' : 'alert-green');
  el.style.display = '';
  el.innerHTML =
    (isNeg ? '🔻' : '🚀') + ' ' +
    '<strong>' + (isNeg ? alert.drops + ' rank drops' : alert.gains + ' rank gains') + ' today</strong> — ' +
    alert.file.replace('.md', '') +
    '<span class="alert-banner-dismiss" onclick="dismissAlert()">Dismiss ×</span>';
}

async function dismissAlert() {
  await fetch('/dismiss-alert', { method: 'POST' });
  document.getElementById('rank-alert-banner').style.display = 'none';
}
```

- [ ] **Step 4: Add DOM targets to the SEO tab HTML**

In the SEO tab HTML panel, add before the pipeline kanban card:
```html
<!-- Rank alert banner -->
<div id="rank-alert-banner" style="display:none"></div>

<!-- SEO Authority -->
<div class="card">
  <div class="card-header accent-indigo"><h2>SEO Authority</h2><span class="section-note">Ahrefs · Updated manually</span></div>
  <div class="card-body" id="seo-authority-panel"><p class="empty-state">Loading...</p></div>
</div>
```

- [ ] **Step 5: Wire into `loadData()`**

In the `loadData()` success handler, after other render calls:
```js
renderSEOAuthorityPanel(d.ahrefsData);
renderRankAlertBanner(d.rankAlert);
```

- [ ] **Step 6: Test with and without a CSV**

```bash
node agents/dashboard/index.js --open
```
With no CSV: "SEO Authority Data Needed" banner shows.

Drop any CSV into `data/ahrefs/` with a `Domain Rating` column. Refresh: authority stats appear.

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/index.js lib/ahrefs-parser.js
git commit -m "feat: SEO Authority panel + rank alert banner in dashboard"
```

---

## Task 5: CRO Tab Restyling + Active Tests Row

**Files:**
- Modify: `agents/dashboard/index.js` (the `renderCROTab` function + CRO tab HTML)

- [ ] **Step 1: Update the 2×2 card accent classes**

In `renderCROTab`, find the card HTML for each source and add the accent class to the card-header:
- Clarity card: `<div class="card-header accent-purple">`
- Shopify card: `<div class="card-header accent-green">`
- GA4 card:     `<div class="card-header accent-orange">`
- GSC card:     `<div class="card-header accent-sky">`

Replace any old `<h2>` style labels (e.g. `CLARITY`, `SHOPIFY`) with display names that match the accent color context.

- [ ] **Step 2: Add `renderActiveTests` client-side function**

```js
function renderActiveTests(d) {
  const el = document.getElementById('active-tests-row');
  if (!el) return;
  const tests = d.metaTests || [];
  const active = tests.filter(t => t.status === 'active');
  if (!active.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  const today = new Date();
  el.querySelector('.test-pills').innerHTML = active.map(t => {
    const start = new Date(t.startDate);
    const day = Math.floor((today - start) / 86400000) + 1;
    const delta = t.currentDelta;
    const deltaClass = delta == null ? 'tp-delta-flat'
      : delta > 0 ? 'tp-delta-pos' : delta < 0 ? 'tp-delta-neg' : 'tp-delta-flat';
    const deltaStr = delta == null ? '—'
      : (delta > 0 ? '+' : '') + (delta * 100).toFixed(2) + 'pp';
    return '<span class="test-pill">' +
      '<span class="tp-slug">' + esc(t.slug) + '</span>' +
      '<span class="tp-day">Day ' + day + '/28</span>' +
      '<span class="' + deltaClass + '">CTR ' + deltaStr + '</span>' +
      '</span>';
  }).join('');
}
```

- [ ] **Step 3: Load meta test files server-side**

Near the other path definitions:
```js
const META_TESTS_DIR = join(ROOT, 'data', 'meta-tests');
```

In the data assembly:
```js
const metaTests = existsSync(META_TESTS_DIR)
  ? readdirSync(META_TESTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(META_TESTS_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
  : [];
```
Include `metaTests` in the JSON response.

- [ ] **Step 4: Add Active Tests DOM target in CRO tab HTML**

Before the `cro-brief-card` div:
```html
<div id="active-tests-row" style="display:none">
  <div class="card">
    <div class="card-header accent-indigo"><h2>Active A/B Tests</h2></div>
    <div class="card-body"><div class="test-pills"></div></div>
  </div>
</div>
```

- [ ] **Step 5: Wire into `loadData()`**

```js
renderActiveTests(d);
```

- [ ] **Step 6: Start dashboard and visually confirm CRO tab**

```bash
node agents/dashboard/index.js --open
```
Expected: CRO cards have colored left-border accents. Active tests row hidden (no tests yet).

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: CRO tab restyling + active A/B tests row"
```

---

## Task 6: Rank Change Alerter Agent

**Files:**
- Create: `agents/rank-alerter/index.js`
- Create: `tests/agents/rank-alerter.test.js`

- [ ] **Step 1: Write failing tests for the diff logic**

Create `tests/agents/rank-alerter.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../../agents/rank-alerter/index.js';

const makeSnap = (queries, pages) => ({
  topQueries: queries,
  topPages: pages || [],
});

test('detects rank drops of 5+ positions', () => {
  const prev = makeSnap([{ query: 'best deodorant', position: 5, clicks: 10, impressions: 100, ctr: 0.1 }]);
  const curr = makeSnap([{ query: 'best deodorant', position: 11, clicks: 5, impressions: 100, ctr: 0.05 }]);
  const result = diffSnapshots(curr, prev);
  assert.equal(result.drops.length, 1);
  assert.equal(result.drops[0].query, 'best deodorant');
  assert.equal(result.drops[0].delta, 6);
});

test('detects new page 1 entries', () => {
  const prev = makeSnap([{ query: 'natural soap', position: 14, clicks: 2, impressions: 50, ctr: 0.04 }]);
  const curr = makeSnap([{ query: 'natural soap', position: 7, clicks: 8, impressions: 50, ctr: 0.16 }]);
  const result = diffSnapshots(curr, prev);
  assert.equal(result.gains.length, 1);
  assert.equal(result.gains[0].query, 'natural soap');
});

test('detects traffic drops of 20%+', () => {
  const prev = makeSnap([], [{ page: '/blogs/news/best-deodorant', clicks: 100 }]);
  const curr = makeSnap([], [{ page: '/blogs/news/best-deodorant', clicks: 75 }]);
  const result = diffSnapshots(curr, prev);
  assert.equal(result.trafficDrops.length, 1);
  assert.ok(result.trafficDrops[0].pctDrop >= 20);
});

test('ignores small changes', () => {
  const prev = makeSnap([{ query: 'foo', position: 5, clicks: 10, impressions: 100, ctr: 0.1 }]);
  const curr = makeSnap([{ query: 'foo', position: 7, clicks: 9, impressions: 100, ctr: 0.09 }]);
  const result = diffSnapshots(curr, prev);
  assert.equal(result.drops.length, 0);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
node --test tests/agents/rank-alerter.test.js
```
Expected: `ERR_MODULE_NOT_FOUND`

- [ ] **Step 3: Create `agents/rank-alerter/index.js`**

```js
/**
 * Rank Alerter Agent
 *
 * Compares yesterday's GSC snapshot against 7 days ago.
 * Flags rank drops (≥5 positions), traffic drops (≥20%), new Page 1 entries.
 * Writes report to data/reports/rank-alerts/YYYY-MM-DD.md
 * Sends notify alert if issues found.
 *
 * Usage:
 *   node agents/rank-alerter/index.js
 *   node agents/rank-alerter/index.js --date 2026-03-18
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const GSC_DIR     = join(ROOT, 'data', 'snapshots', 'gsc');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'rank-alerts');

// ── pure diff function (exported for tests) ────────────────────────────────

export function diffSnapshots(curr, prev) {
  const drops       = [];
  const gains       = [];
  const trafficDrops = [];

  // Build prev query map
  const prevQueries = new Map((prev.topQueries || []).map(q => [q.query, q]));

  for (const q of (curr.topQueries || [])) {
    const p = prevQueries.get(q.query);
    if (!p) continue;
    const delta = q.position - p.position; // positive = rank got worse
    if (delta >= 5) {
      drops.push({ query: q.query, from: p.position, to: q.position, delta });
    } else if (delta <= -5 && q.position <= 10) {
      gains.push({ query: q.query, from: p.position, to: q.position, delta: Math.abs(delta) });
    }
  }

  // Page-level traffic drops
  const prevPages = new Map((prev.topPages || []).map(p => [p.page, p]));
  for (const pg of (curr.topPages || [])) {
    const p = prevPages.get(pg.page);
    if (!p || p.clicks === 0) continue;
    const pctDrop = ((p.clicks - pg.clicks) / p.clicks) * 100;
    if (pctDrop >= 20) {
      trafficDrops.push({ page: pg.page, from: p.clicks, to: pg.clicks, pctDrop: Math.round(pctDrop) });
    }
  }

  return { drops, gains, trafficDrops };
}

// ── date helpers ──────────────────────────────────────────────────────────

function ptDate(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function loadSnapshot(date) {
  const p = join(GSC_DIR, `${date}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
  const targetDate = dateArg || ptDate(1); // default: yesterday
  const compareDate = (() => {
    const d = new Date(targetDate + 'T12:00:00Z');
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  })();

  console.log(`Rank Alerter — ${targetDate} vs ${compareDate}`);

  const curr = loadSnapshot(targetDate);
  const prev = loadSnapshot(compareDate);

  if (!curr) { console.log(`No snapshot for ${targetDate}, skipping.`); return; }
  if (!prev) { console.log(`No snapshot for ${compareDate}, skipping.`); return; }

  const { drops, gains, trafficDrops } = diffSnapshots(curr, prev);

  if (!drops.length && !gains.length && !trafficDrops.length) {
    console.log('No significant changes detected.');
    return;
  }

  // Build report
  const lines = [`# Rank Alert — ${targetDate}`, ''];
  if (drops.length) {
    lines.push('## 🔻 Rank Drops (≥5 positions)');
    for (const d of drops) lines.push(`- **${d.query}**: ${d.from.toFixed(1)} → ${d.to.toFixed(1)} (Δ${d.delta.toFixed(1)})`);
    lines.push('');
  }
  if (gains.length) {
    lines.push('## 🚀 New Page 1 Entries');
    for (const g of gains) lines.push(`- **${g.query}**: ${g.from.toFixed(1)} → ${g.to.toFixed(1)} (+${g.delta.toFixed(1)})`);
    lines.push('');
  }
  if (trafficDrops.length) {
    lines.push('## 📉 Traffic Drops (≥20% week-over-week)');
    for (const t of trafficDrops) lines.push(`- **${t.page}**: ${t.from} → ${t.to} clicks (−${t.pctDrop}%)`);
    lines.push('');
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, `${targetDate}.md`);
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`Report saved: ${reportPath}`);

  const isNeg = drops.length > gains.length;
  await notify({
    subject: `Rank Alert ${targetDate}: ${drops.length} drops, ${gains.length} gains`,
    body: lines.join('\n'),
    status: isNeg ? 'error' : 'success',
  });
  console.log('Notification sent.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4: Run tests — confirm pass**

```bash
node --test tests/agents/rank-alerter.test.js
```
Expected: 4 passing

- [ ] **Step 5: Smoke test with real data**

```bash
node agents/rank-alerter/index.js
```
Expected: Either "No snapshot for [date], skipping." or a report file written to `data/reports/rank-alerts/`.

- [ ] **Step 6: Commit**

```bash
git add agents/rank-alerter/index.js tests/agents/rank-alerter.test.js
git commit -m "feat: rank alerter agent — GSC snapshot diff with notify"
```

---

## Task 7: Pipeline Scheduler Agent

**Files:**
- Create: `agents/pipeline-scheduler/index.js`

- [ ] **Step 1: Create `agents/pipeline-scheduler/index.js`**

```js
/**
 * Pipeline Scheduler Agent
 *
 * Reads the content calendar, finds keywords due for a brief in the next 14 days,
 * and runs content-researcher for the first one that doesn't already have a brief.
 * Runs at most 1 brief per execution to avoid API overuse.
 *
 * Usage:
 *   node agents/pipeline-scheduler/index.js
 *   node agents/pipeline-scheduler/index.js --dry-run   (show what would run, skip research)
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CALENDAR_PATH = join(ROOT, 'data', 'reports', 'content-strategist', 'content-calendar.md');
const BRIEFS_DIR    = join(ROOT, 'data', 'briefs');

function kwToSlug(kw) {
  return kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseCalendar() {
  if (!existsSync(CALENDAR_PATH)) return [];
  const md = readFileSync(CALENDAR_PATH, 'utf8');
  const rows = [];
  const re = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;
  for (const m of md.matchAll(re)) {
    const [, week, dateStr, , keyword] = m;
    if (week.trim() === 'Week' || week.trim() === '---') continue;
    const dm = dateStr.trim().match(/([A-Za-z]+)\s+(\d+),?\s+(\d{4})/);
    if (!dm) continue;
    rows.push({
      keyword: keyword.trim(),
      slug: kwToSlug(keyword.trim()),
      publishDate: new Date(`${dm[1]} ${dm[2]}, ${dm[3]} 08:00:00 GMT-0700`),
    });
  }
  return rows;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('Pipeline Scheduler' + (dryRun ? ' (dry run)' : ''));

  if (!existsSync(CALENDAR_PATH)) {
    console.log('No content calendar found. Run content-strategist first.');
    return;
  }

  const rows = parseCalendar();
  const now = new Date();
  const horizon = new Date(now.getTime() + 14 * 86400000);

  // Find keywords due within 14 days with no brief
  const due = rows.filter(r =>
    r.publishDate >= now &&
    r.publishDate <= horizon &&
    !existsSync(join(BRIEFS_DIR, `${r.slug}.json`))
  );

  if (!due.length) {
    console.log('No briefs needed in the next 14 days.');
    return;
  }

  const target = due[0]; // process one per run
  console.log(`Brief needed: "${target.keyword}" (due ${target.publishDate.toDateString()})`);

  if (dryRun) {
    console.log('[dry-run] Would run: node agents/content-researcher/index.js "' + target.keyword + '"');
    return;
  }

  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'agents', 'content-researcher', 'index.js'), target.keyword],
    { stdio: 'inherit', cwd: ROOT }
  );

  if (result.status === 0) {
    await notify({
      subject: `Brief ready: "${target.keyword}"`,
      body: `Pipeline scheduler created brief for "${target.keyword}".\nSlug: ${target.slug}`,
      status: 'success',
    });
    console.log('Brief created and notification sent.');
  } else {
    await notify({
      subject: `Brief FAILED: "${target.keyword}"`,
      body: `content-researcher exited with status ${result.status}`,
      status: 'error',
    });
    console.error('content-researcher failed.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Smoke test with dry run**

```bash
node agents/pipeline-scheduler/index.js --dry-run
```
Expected: Either "No briefs needed" or "[dry-run] Would run: node agents/content-researcher/index.js [keyword]"

- [ ] **Step 3: Commit**

```bash
git add agents/pipeline-scheduler/index.js
git commit -m "feat: pipeline scheduler agent — auto-brief from content calendar"
```

---

## Task 8: Publisher Post-Publish Verification

**Files:**
- Modify: `agents/publisher/index.js`

- [ ] **Step 1: Add `--no-verify` flag parsing**

Near the other flag parsing at the top:
```js
const skipVerify = args.includes('--no-verify');
```

- [ ] **Step 2: Add verifier spawn after successful publish**

At the end of `main()`, after `console.log('\nPublish complete.')`, add:

Note: `slug` and `meta` are already available in `main()` — `slug` is derived from `basename(metaPath, '.json')` and `meta` is the parsed post JSON loaded earlier in the function.

```js
// Post-publish verification (skippable with --no-verify)
if (!skipVerify && !isDraft) {
  console.log('\nRunning post-publish verifier...');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'agents', 'blog-post-verifier', 'index.js'), `data/posts/${slug}.json`],
    { stdio: 'inherit', cwd: ROOT }
  );
  if (result.status !== 0) {
    console.warn('⚠ Verifier found issues — check data/reports/verifier/' + slug + '-*.md');
    const { notify } = await import('../../lib/notify.js');
    await notify({
      subject: `Verifier issues: "${meta.title}"`,
      body: `Post published but verifier flagged issues.\nCheck: data/reports/verifier/${slug}-*.md`,
      status: 'error',
    });
  }
}
```

- [ ] **Step 3: Update the usage comment**

Note: The plan uses `--no-verify` (opt-out) rather than `--verify` (opt-in) as the flag name — semantically identical behavior, cleaner ergonomics.

```js
 *   node agents/publisher/index.js data/posts/<slug>.json --no-verify  (skip post-publish check)
```

- [ ] **Step 4: Smoke test**

```bash
node agents/publisher/index.js --help 2>&1 || true
```
Confirm the file parses without errors (no crash on import).

- [ ] **Step 5: Commit**

```bash
git add agents/publisher/index.js
git commit -m "feat: publisher spawns verifier after publish, skippable with --no-verify"
```

---

## Task 9: Meta A/B Test Creation Script

**Files:**
- Create: `scripts/create-meta-test.js`
- Create: `data/meta-tests/.gitkeep`

- [ ] **Step 1: Create `data/meta-tests/` directory**

```bash
mkdir -p data/meta-tests
touch data/meta-tests/.gitkeep
git add data/meta-tests/.gitkeep
```

- [ ] **Step 2: Create `scripts/create-meta-test.js`**

```js
#!/usr/bin/env node
/**
 * Create Meta A/B Test
 *
 * Generates a Variant B title tag for a published post, writes a test file,
 * and applies Variant B via Shopify's global.title_tag metafield.
 *
 * Usage:
 *   node scripts/create-meta-test.js <slug>
 *   node scripts/create-meta-test.js <slug> --dry-run
 *
 * Requires: ANTHROPIC_API_KEY in .env
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

const env = loadEnv();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
const SHOPIFY_TOKEN     = process.env.SHOPIFY_ACCESS_TOKEN || env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE     = process.env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_STORE_DOMAIN;

const args = process.argv.slice(2);
const slug = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!slug) {
  console.error('Usage: node scripts/create-meta-test.js <slug> [--dry-run]');
  process.exit(1);
}

const POSTS_DIR      = join(ROOT, 'data', 'posts');
const BRIEFS_DIR     = join(ROOT, 'data', 'briefs');
const META_TESTS_DIR = join(ROOT, 'data', 'meta-tests');
const GSC_DIR        = join(ROOT, 'data', 'snapshots', 'gsc');

// ── load post metadata ─────────────────────────────────────────────────────

const metaPath = join(POSTS_DIR, `${slug}.json`);
if (!existsSync(metaPath)) { console.error(`Post not found: ${metaPath}`); process.exit(1); }
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

if (!meta.shopify_article_id) {
  console.error('Post is not published to Shopify. Publish it first.');
  process.exit(1);
}

// ── check for existing active test ────────────────────────────────────────

const testPath = join(META_TESTS_DIR, `${slug}.json`);
if (existsSync(testPath)) {
  const existing = JSON.parse(readFileSync(testPath, 'utf8'));
  if (existing.status === 'active') {
    console.error(`Active test already exists for "${slug}". Conclude it first.`);
    process.exit(1);
  }
}

// ── measure baseline CTR from GSC snapshots ───────────────────────────────

function getBaselineCTR() {
  if (!existsSync(GSC_DIR)) return null;
  const end = new Date();
  const start = new Date(end.getTime() - 28 * 86400000);
  const path  = meta.shopify_url ? new URL(meta.shopify_url).pathname : null;
  if (!path) return null;

  const snapFiles = readdirSync(GSC_DIR)
    .filter(f => f.endsWith('.json'))
    .filter(f => {
      const d = new Date(f.replace('.json', '') + 'T12:00:00Z');
      return d >= start && d < end;
    });

  const ctrs = [];
  for (const f of snapFiles) {
    try {
      const snap = JSON.parse(readFileSync(join(GSC_DIR, f), 'utf8'));
      const pg = (snap.topPages || []).find(p => p.page.endsWith(path));
      if (pg?.ctr != null) ctrs.push(pg.ctr);
    } catch { /* skip */ }
  }
  return ctrs.length ? ctrs.reduce((a, b) => a + b, 0) / ctrs.length : null;
}

// ── generate Variant B title ──────────────────────────────────────────────

async function generateVariantB() {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const keyword = meta.target_keyword || slug.replace(/-/g, ' ');
  const prompt = `You are an SEO expert. Write an alternative title tag for a blog post.

Current title: ${meta.title}
Target keyword: ${keyword}

Requirements:
- Under 60 characters
- Include the target keyword naturally
- Different angle/phrasing from the original
- Compelling for searchers
- Do not use the exact same opening words as the original

Reply with ONLY the title tag text, no quotes, no explanation.`;

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text.trim();
}

// ── apply metafield to Shopify ────────────────────────────────────────────

async function applyMetafield(articleId, blogId, titleTag) {
  // Shopify metafield: global.title_tag on article
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/blogs/${blogId}/articles/${articleId}/metafields.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      metafield: {
        namespace: 'global',
        key: 'title_tag',
        value: titleTag,
        type: 'single_line_text_field',
      },
    }),
  });
  if (!res.ok) throw new Error(`Shopify metafield update failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Creating A/B test for: "${meta.title}"`);

  const baselineCTR = getBaselineCTR();
  console.log(`Baseline CTR: ${baselineCTR != null ? (baselineCTR * 100).toFixed(2) + '%' : 'insufficient data'}`);

  console.log('Generating Variant B title...');
  const variantB = await generateVariantB();
  console.log(`Variant A: ${meta.title}`);
  console.log(`Variant B: ${variantB}`);

  if (dryRun) {
    console.log('[dry-run] Would write test file and apply Shopify metafield.');
    return;
  }

  // Write test file
  const startDate = new Date().toISOString().slice(0, 10);
  const concludeDate = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
  mkdirSync(META_TESTS_DIR, { recursive: true });
  const testData = {
    slug,
    startDate,
    concludeDate,
    variantA: meta.title,
    variantB,
    baselineCTR,
    status: 'active',
    currentDelta: null,
    baselineMean: baselineCTR,
    testMean: null,
    daysRemaining: 28,
  };
  writeFileSync(testPath, JSON.stringify(testData, null, 2));
  console.log(`Test file written: ${testPath}`);

  // Apply to Shopify
  if (!SHOPIFY_TOKEN || !SHOPIFY_STORE) {
    console.warn('Shopify credentials not set — skipping metafield update.');
    return;
  }
  console.log('Applying Variant B to Shopify (global.title_tag)...');
  await applyMetafield(meta.shopify_article_id, meta.shopify_blog_id, variantB);
  console.log('Done. Variant B is now live.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 3: Smoke test with dry run**

```bash
node scripts/create-meta-test.js best-natural-deodorant-for-women --dry-run
```
Expected: Shows current + generated variant B title, logs "[dry-run] Would write test file..."

- [ ] **Step 4: Add npm script**

In `package.json` scripts:
```json
"meta-test": "node scripts/create-meta-test.js"
```

- [ ] **Step 5: Commit**

```bash
git add scripts/create-meta-test.js data/meta-tests/.gitkeep package.json
git commit -m "feat: create-meta-test script — generates Variant B title + Shopify metafield"
```

---

## Task 10: Meta A/B Tracker Agent

**Files:**
- Create: `agents/meta-ab-tracker/index.js`
- Create: `tests/agents/meta-ab-tracker.test.js`

- [ ] **Step 1: Write failing tests for CTR delta calculation**

Create `tests/agents/meta-ab-tracker.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCTRDelta } from '../../agents/meta-ab-tracker/index.js';

test('computes positive delta when test CTR is higher', () => {
  const delta = computeCTRDelta(0.05, 0.04);
  assert.ok(delta > 0);
  assert.ok(Math.abs(delta - 0.01) < 0.0001);
});

test('computes negative delta when test CTR is lower', () => {
  const delta = computeCTRDelta(0.03, 0.05);
  assert.ok(delta < 0);
  assert.ok(Math.abs(delta - (-0.02)) < 0.0001);
});

test('returns null when either value is null', () => {
  assert.equal(computeCTRDelta(null, 0.04), null);
  assert.equal(computeCTRDelta(0.04, null), null);
  assert.equal(computeCTRDelta(null, null), null);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
node --test tests/agents/meta-ab-tracker.test.js
```
Expected: `ERR_MODULE_NOT_FOUND`

- [ ] **Step 3: Create `agents/meta-ab-tracker/index.js`**

```js
/**
 * Meta A/B Tracker Agent
 *
 * Runs weekly (Mondays). For each active meta test, computes CTR delta
 * from GSC snapshots (pre-test baseline mean vs test-period mean).
 * After 28 days, concludes the test: reverts Shopify metafield if Variant B lost.
 *
 * Usage:
 *   node agents/meta-ab-tracker/index.js
 *   node agents/meta-ab-tracker/index.js --dry-run
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const META_TESTS_DIR = join(ROOT, 'data', 'meta-tests');
const GSC_DIR        = join(ROOT, 'data', 'snapshots', 'gsc');
const RESULTS_DIR    = join(ROOT, 'data', 'reports', 'meta-tests');

// ── pure exports (for tests) ───────────────────────────────────────────────

export function computeCTRDelta(testMean, baselineMean) {
  if (testMean == null || baselineMean == null) return null;
  return testMean - baselineMean; // absolute percentage points
}

// ── GSC helpers ────────────────────────────────────────────────────────────

function getCTRsForPage(pagePath, fromDate, toDate) {
  if (!existsSync(GSC_DIR)) return [];
  const start = new Date(fromDate + 'T12:00:00Z');
  const end   = new Date(toDate   + 'T12:00:00Z');
  const ctrs  = [];

  readdirSync(GSC_DIR)
    .filter(f => f.endsWith('.json'))
    .forEach(f => {
      const d = new Date(f.replace('.json', '') + 'T12:00:00Z');
      if (d < start || d > end) return;
      try {
        const snap = JSON.parse(readFileSync(join(GSC_DIR, f), 'utf8'));
        const pg = (snap.topPages || []).find(p => p.page && p.page.endsWith(pagePath));
        if (pg?.ctr != null) ctrs.push(pg.ctr);
      } catch { /* skip */ }
    });

  return ctrs;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

// ── Shopify helper ─────────────────────────────────────────────────────────

async function revertMetafield(articleId, blogId, originalTitle) {
  function loadEnv() {
    try {
      const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
      const e = {};
      for (const l of lines) {
        const t = l.trim(); if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('='); if (i === -1) continue;
        e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
      return e;
    } catch { return {}; }
  }
  const env = loadEnv();
  const token = process.env.SHOPIFY_ACCESS_TOKEN || env.SHOPIFY_ACCESS_TOKEN;
  const store = process.env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_STORE_DOMAIN;
  if (!token || !store) { console.warn('Shopify credentials not set, skipping revert.'); return; }

  const url = `https://${store}/admin/api/2024-01/blogs/${blogId}/articles/${articleId}/metafields.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ metafield: { namespace: 'global', key: 'title_tag', value: originalTitle, type: 'single_line_text_field' } }),
  });
  if (!res.ok) console.warn(`Revert failed: ${res.status}`);
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('Meta A/B Tracker' + (dryRun ? ' (dry run)' : ''));

  if (!existsSync(META_TESTS_DIR)) { console.log('No meta tests directory.'); return; }

  const testFiles = readdirSync(META_TESTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  const activeTests = testFiles
    .map(f => { try { return { f, t: JSON.parse(readFileSync(join(META_TESTS_DIR, f), 'utf8')) }; } catch { return null; } })
    .filter(x => x && x.t.status === 'active');

  if (!activeTests.length) { console.log('No active tests.'); return; }

  for (const { f, t } of activeTests) {
    console.log(`\nProcessing: ${t.slug}`);
    const today    = new Date().toISOString().slice(0, 10);
    const start    = new Date(t.startDate + 'T12:00:00Z');
    const conclude = new Date(t.concludeDate + 'T12:00:00Z');
    const daysRemaining = Math.max(0, Math.ceil((conclude - new Date()) / 86400000));

    // Get page path from slug
    const metaPath = join(ROOT, 'data', 'posts', `${t.slug}.json`);
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
    const pagePath = meta?.shopify_url ? new URL(meta.shopify_url).pathname : `/${t.slug}`;

    // Compute baseline (28 days before startDate)
    const baselineStart = new Date(start.getTime() - 28 * 86400000).toISOString().slice(0, 10);
    const baselineEnd   = t.startDate;
    const baselineCTRs  = getCTRsForPage(pagePath, baselineStart, baselineEnd);
    const baselineMean  = t.baselineMean ?? mean(baselineCTRs);

    // Compute test period mean
    const testCTRs = getCTRsForPage(pagePath, t.startDate, today);
    const testMean = mean(testCTRs);
    const delta    = computeCTRDelta(testMean, baselineMean);

    console.log(`  Baseline mean: ${baselineMean != null ? (baselineMean * 100).toFixed(3) + '%' : 'n/a'}`);
    console.log(`  Test mean:     ${testMean     != null ? (testMean     * 100).toFixed(3) + '%' : 'n/a (insufficient data)'}`);
    console.log(`  Delta:         ${delta != null ? (delta * 100).toFixed(3) + 'pp' : 'n/a'}`);
    console.log(`  Days remaining: ${daysRemaining}`);

    t.baselineMean  = baselineMean;
    t.testMean      = testMean;
    t.currentDelta  = delta;
    t.daysRemaining = daysRemaining;

    // Conclude if past 28 days
    if (new Date() >= conclude) {
      const winner = delta != null && delta > 0 ? 'B' : 'A';
      t.status  = 'concluded';
      t.winner  = winner;
      t.concludedDate = today;
      console.log(`  → Test concluded. Winner: Variant ${winner}`);

      if (!dryRun) {
        // Revert to A if B lost
        if (winner === 'A' && meta?.shopify_article_id) {
          console.log('  Reverting to Variant A...');
          await revertMetafield(meta.shopify_article_id, meta.shopify_blog_id, t.variantA);
        }

        // Write result report
        mkdirSync(RESULTS_DIR, { recursive: true });
        const report = [
          `# A/B Test Result: ${t.slug}`,
          `**Period:** ${t.startDate} → ${today}`,
          `**Winner:** Variant ${winner}`,
          `**Variant A:** ${t.variantA}`,
          `**Variant B:** ${t.variantB}`,
          `**Baseline CTR:** ${baselineMean != null ? (baselineMean * 100).toFixed(3) + '%' : 'n/a'}`,
          `**Test CTR:**     ${testMean     != null ? (testMean     * 100).toFixed(3) + '%' : 'n/a'}`,
          `**Delta:**        ${delta != null ? (delta >= 0 ? '+' : '') + (delta * 100).toFixed(3) + 'pp' : 'n/a'}`,
          winner === 'A' ? '\nVariant A title restored on Shopify.' : '\nVariant B title retained on Shopify.',
        ].join('\n');
        writeFileSync(join(RESULTS_DIR, `${t.slug}-result.md`), report);

        await notify({
          subject: `A/B Test concluded: ${t.slug} — Variant ${winner} wins`,
          body: report,
          status: 'success',
        });
      }
    }

    if (!dryRun) {
      writeFileSync(join(META_TESTS_DIR, f), JSON.stringify(t, null, 2));
      console.log(`  Test file updated.`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4: Run tests — confirm pass**

```bash
node --test tests/agents/meta-ab-tracker.test.js
```
Expected: 3 passing

- [ ] **Step 5: Smoke test**

```bash
node agents/meta-ab-tracker/index.js --dry-run
```
Expected: "No active tests." (or shows test data if any tests exist)

- [ ] **Step 6: Commit**

```bash
git add agents/meta-ab-tracker/index.js tests/agents/meta-ab-tracker.test.js
git commit -m "feat: meta A/B tracker agent — weekly CTR tracking + conclusion"
```

---

## Task 11: Cron Jobs + npm Scripts

**Files:**
- Modify: `scripts/setup-cron.sh`
- Modify: `package.json`

- [ ] **Step 1: Add new cron entries to `setup-cron.sh`**

Find the block of `DAILY_*` / `WEEKLY_*` variable definitions and add:
```bash
DAILY_RANK_ALERTER="30 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/rank-alerter/index.js >> data/reports/scheduler/rank-alerter.log 2>&1"
DAILY_PIPELINE_SCHEDULER="0 15 * * * cd \"$PROJECT_DIR\" && $NODE agents/pipeline-scheduler/index.js >> data/reports/scheduler/pipeline-scheduler.log 2>&1"
WEEKLY_META_AB_TRACKER="0 15 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/meta-ab-tracker/index.js >> data/reports/scheduler/meta-ab-tracker.log 2>&1"
```

Note: Rank alerter at 13:30 PT runs after GSC collector (13:15 PT), giving GSC data time to land. Pipeline scheduler at 15:00 PT. Meta tracker Mondays at 15:00 PT.

Find the `NEW_CRONTAB` block and add the new variables:
```bash
$DAILY_RANK_ALERTER
$DAILY_PIPELINE_SCHEDULER
$WEEKLY_META_AB_TRACKER
```

Add echo lines:
```bash
echo "  Daily   06:30 PDT / 05:30 PST — rank-alerter"
echo "  Daily   08:00 PDT / 07:00 PST — pipeline-scheduler"
echo "  Weekly  Mon 08:00 PDT — meta-ab-tracker"
```

- [ ] **Step 2: Add npm scripts to `package.json`**

```json
"rank-alerter":         "node agents/rank-alerter/index.js",
"pipeline-scheduler":   "node agents/pipeline-scheduler/index.js",
"meta-ab-tracker":      "node agents/meta-ab-tracker/index.js",
"meta-test-create":     "node scripts/create-meta-test.js"
```

- [ ] **Step 3: Verify setup-cron.sh is valid**

```bash
bash -n scripts/setup-cron.sh
```
Expected: no output (syntax valid)

- [ ] **Step 4: Run all tests**

```bash
node --test 'tests/**/*.test.js'
```
Expected: all passing

- [ ] **Step 5: Final commit**

```bash
git add scripts/setup-cron.sh package.json
git commit -m "feat: add cron entries and npm scripts for new agents"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `node agents/dashboard/index.js --open` — deep indigo hero, Inter font, tab-contextual KPIs work
- [ ] Drop a CSV into `data/ahrefs/` — SEO Authority panel shows values on refresh
- [ ] `node agents/rank-alerter/index.js` — runs without error, either "no snapshot" or creates report
- [ ] `node agents/pipeline-scheduler/index.js --dry-run` — shows keyword due or "no briefs needed"
- [ ] `node agents/meta-ab-tracker/index.js --dry-run` — runs without error
- [ ] `node scripts/create-meta-test.js <published-slug> --dry-run` — shows generated variant B
- [ ] `node --test 'tests/**/*.test.js'` — all tests pass
- [ ] `bash -n scripts/setup-cron.sh` — no syntax errors
