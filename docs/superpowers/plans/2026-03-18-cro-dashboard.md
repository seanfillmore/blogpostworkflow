# CRO Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily data collection system for Microsoft Clarity and Shopify CRO metrics, a weekly AI analysis agent, and a new CRO tab on the existing SEO dashboard.

**Architecture:** Three new cron agents (clarity-collector, shopify-collector, cro-analyzer) save daily/weekly JSON snapshots following the existing rank-tracker pattern. A new CRO tab on the dashboard reads those files at render time — no live API calls. Tab navigation (SEO | CRO) is added to the dashboard header.

**Tech Stack:** Node.js ES modules, Anthropic SDK (`@anthropic-ai/sdk`), existing `lib/shopify.js` pattern, `lib/notify.js` for email notifications.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/clarity.js` | Create | Clarity API client — fetches and normalizes live-insights response |
| `lib/shopify.js` | Modify | Add `getOrders(dateFrom, dateTo)` and `getAbandonedCheckouts(dateFrom, dateTo)` |
| `agents/clarity-collector/index.js` | Create | Daily agent — calls lib/clarity.js, saves `data/snapshots/clarity/YYYY-MM-DD.json` |
| `agents/shopify-collector/index.js` | Create | Daily agent — calls lib/shopify.js, saves `data/snapshots/shopify/YYYY-MM-DD.json` |
| `agents/cro-analyzer/index.js` | Create | Weekly agent — reads last 7 snapshots from both sources, calls Claude, saves `data/reports/cro/YYYY-MM-DD-cro-brief.md` |
| `agents/dashboard/index.js` | Modify | Add `parseCROData()`, tab nav HTML, `renderCROTab()` client-side function |

---

## Task 1: `lib/clarity.js` — Clarity API Client

**Files:**
- Create: `lib/clarity.js`

- [ ] **Step 1: Create `lib/clarity.js`**

```js
/**
 * Microsoft Clarity API client
 * Endpoint: project-live-insights
 * Reads MICROSOFT_CLARITY_TOKEN from .env
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const TOKEN = process.env.MICROSOFT_CLARITY_TOKEN || env.MICROSOFT_CLARITY_TOKEN;
const ENDPOINT = process.env.MICROSOFT_CLARITY_ENDPOINT || env.MICROSOFT_CLARITY_ENDPOINT
  || 'www.clarity.ms/export-data/api/v1/project-live-insights';

if (!TOKEN) throw new Error('Missing MICROSOFT_CLARITY_TOKEN in .env');

function find(data, metricName) {
  const item = data.find(d => d.metricName === metricName);
  return item?.information?.[0] ?? null;
}

/**
 * Fetch and normalize the Clarity live-insights snapshot.
 * Returns null if no session data is available.
 */
export async function fetchClarityInsights() {
  const url = `https://${ENDPOINT}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Clarity API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const traffic = find(data, 'Traffic');
  const totalSessions = Number(traffic?.totalSessionCount ?? 0);
  if (totalSessions === 0) return null; // no data — skip snapshot

  const eng = find(data, 'EngagementTime');
  const scroll = find(data, 'ScrollDepth');

  const pct = (name) => Number(find(data, name)?.sessionsWithMetricPercentage ?? 0);

  const devices = (data.find(d => d.metricName === 'Device')?.information ?? [])
    .map(d => ({ name: d.name, sessions: Number(d.sessionsCount) }));

  const countries = (data.find(d => d.metricName === 'Country')?.information ?? [])
    .map(d => ({ name: d.name, sessions: Number(d.sessionsCount) }));

  const topPages = (data.find(d => d.metricName === 'PageTitle')?.information ?? [])
    .slice(0, 10)
    .map(d => ({ title: d.name, sessions: Number(d.sessionsCount) }));

  const bots = Number(traffic?.totalBotSessionCount ?? 0);

  return {
    sessions: {
      total: totalSessions,
      bots,
      real: totalSessions - bots,
      distinctUsers: Number(traffic?.distinctUserCount ?? 0),
      pagesPerSession: Number(traffic?.pagesPerSessionPercentage ?? 0),
    },
    engagement: {
      totalTime: Number(eng?.totalTime ?? 0),
      activeTime: Number(eng?.activeTime ?? 0),
    },
    behavior: {
      scrollDepth:       Number(scroll?.averageScrollDepth ?? 0),
      rageClickPct:      pct('RageClickCount'),
      deadClickPct:      pct('DeadClickCount'),
      scriptErrorPct:    pct('ScriptErrorCount'),
      quickbackPct:      pct('QuickbackClick'),
      excessiveScrollPct:pct('ExcessiveScroll'),
    },
    devices,
    countries,
    topPages,
  };
}
```

- [ ] **Step 2: Smoke-test the client**

```bash
node -e "
import('/Users/seanfillmore/Code/Claude/lib/clarity.js').then(async m => {
  const data = await m.fetchClarityInsights();
  console.log(JSON.stringify(data, null, 2));
}).catch(e => console.error(e.message));
"
```

Expected: JSON object with `sessions`, `engagement`, `behavior`, `devices`, `countries`, `topPages` fields. No error.

- [ ] **Step 3: Commit**

```bash
git add lib/clarity.js
git commit -m "feat: add lib/clarity.js — Clarity API client"
```

---

## Task 2: `lib/shopify.js` — Add `getOrders` and `getAbandonedCheckouts`

**Files:**
- Modify: `lib/shopify.js` (append two new exported functions after the existing exports)

- [ ] **Step 1: Append `getOrders` to `lib/shopify.js`**

Open `lib/shopify.js` and add at the end of the file:

```js
/**
 * Fetch all orders within a date range.
 * Returns { count, revenue, aov, rawOrders }.
 * rawOrders is included so callers can compute topProducts from line_items.
 * Uses limit=250 (Shopify max). Sufficient for daily snapshots on this store.
 */
export async function getOrders(dateFrom, dateTo) {
  const res = await shopifyRequest('GET', `/orders.json?status=any&created_at_min=${dateFrom}&created_at_max=${dateTo}&limit=250`);
  const orders = res.orders ?? [];
  const count = orders.length;
  const revenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const aov = count > 0 ? revenue / count : 0;
  return { count, revenue: Math.round(revenue * 100) / 100, aov: Math.round(aov * 100) / 100, rawOrders: orders };
}

/**
 * Fetch all abandoned checkouts within a date range.
 * Returns { count }.
 */
export async function getAbandonedCheckouts(dateFrom, dateTo) {
  const res = await shopifyRequest('GET', `/checkouts.json?created_at_min=${dateFrom}&created_at_max=${dateTo}&limit=250`);
  const checkouts = res.checkouts ?? [];
  const incomplete = checkouts.filter(c => !c.completed_at);
  return { count: incomplete.length };
}
```

- [ ] **Step 2: Smoke-test the new functions**

```bash
node -e "
import('/Users/seanfillmore/Code/Claude/lib/shopify.js').then(async m => {
  const today = new Date().toISOString().slice(0,10);
  const weekAgo = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
  const orders = await m.getOrders(weekAgo + 'T00:00:00Z', today + 'T23:59:59Z');
  console.log('Orders:', orders.count, 'Revenue:', orders.revenue);
  const checkouts = await m.getAbandonedCheckouts(weekAgo + 'T00:00:00Z', today + 'T23:59:59Z');
  console.log('Abandoned checkouts:', checkouts.count);
}).catch(e => console.error(e.message));
"
```

Expected: order count and revenue printed, abandoned checkout count printed. No error.

- [ ] **Step 3: Commit**

```bash
git add lib/shopify.js
git commit -m "feat: add getOrders and getAbandonedCheckouts to lib/shopify.js"
```

---

## Task 3: `agents/clarity-collector/index.js`

**Files:**
- Create: `agents/clarity-collector/index.js`

- [ ] **Step 1: Create `agents/clarity-collector/index.js`**

```js
/**
 * Clarity Collector Agent
 *
 * Fetches today's Microsoft Clarity live-insights snapshot and saves it to:
 *   data/snapshots/clarity/YYYY-MM-DD.json
 *
 * Exits early without writing a file if sessions.total === 0.
 *
 * Usage:
 *   node agents/clarity-collector/index.js
 *   node agents/clarity-collector/index.js --date 2026-03-17   # backfill
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchClarityInsights } from '../../lib/clarity.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'clarity');

const dateArg = process.argv.find(a => a.startsWith('--date'))?.split('=')[1]
  ?? process.argv[process.argv.indexOf('--date') + 1];
const date = dateArg || new Date().toISOString().slice(0, 10);

async function main() {
  console.log('Clarity Collector\n');
  console.log(`  Date: ${date}`);
  process.stdout.write('  Fetching Clarity insights... ');

  const data = await fetchClarityInsights();

  if (!data) {
    console.log('no session data — skipping snapshot');
    return;
  }

  console.log(`done (${data.sessions.real} real sessions, ${data.sessions.bots} bots)`);

  const snapshot = { date, ...data };
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
}

main()
  .then(() => notify({ subject: 'Clarity Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }))
  .catch(err => {
    notify({ subject: 'Clarity Collector failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
```

- [ ] **Step 2: Run it and verify the snapshot**

```bash
node agents/clarity-collector/index.js
```

Expected output:
```
Clarity Collector

  Date: 2026-03-18
  Fetching Clarity insights... done (11 real sessions, 32 bots)
  Snapshot saved: data/snapshots/clarity/2026-03-18.json
```

Then verify the file:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('data/snapshots/clarity/2026-03-18.json','utf8')).sessions)"
```

Expected: `{ total: 43, bots: 32, real: 11, distinctUsers: 73, pagesPerSession: 1.13 }` (values will vary by actual API response).

- [ ] **Step 3: Commit**

```bash
git add agents/clarity-collector/index.js
git commit -m "feat: add clarity-collector agent"
```

---

## Task 4: `agents/shopify-collector/index.js`

**Files:**
- Create: `agents/shopify-collector/index.js`

- [ ] **Step 1: Create `agents/shopify-collector/index.js`**

```js
/**
 * Shopify Collector Agent
 *
 * Fetches today's Shopify CRO data (orders, abandoned checkouts, top products)
 * and saves a snapshot to:
 *   data/snapshots/shopify/YYYY-MM-DD.json
 *
 * Usage:
 *   node agents/shopify-collector/index.js
 *   node agents/shopify-collector/index.js --date 2026-03-17
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOrders, getAbandonedCheckouts } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'shopify');

const dateArg = process.argv.find(a => a.startsWith('--date'))?.split('=')[1]
  ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
const date = dateArg || new Date().toISOString().slice(0, 10);

function buildTopProducts(rawOrders) {
  const map = new Map();
  for (const order of rawOrders) {
    for (const item of (order.line_items || [])) {
      const title = item.title;
      const rev = parseFloat(item.price || 0) * (item.quantity || 1);
      if (!map.has(title)) map.set(title, { title, revenue: 0, orders: 0 });
      const entry = map.get(title);
      entry.revenue += rev;
      entry.orders += 1;
    }
  }
  return [...map.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map(p => ({ title: p.title, revenue: Math.round(p.revenue * 100) / 100, orders: p.orders }));
}

async function main() {
  console.log('Shopify Collector\n');
  console.log(`  Date: ${date}`);

  const dayStart = `${date}T00:00:00-07:00`; // Pacific time
  const dayEnd   = `${date}T23:59:59-07:00`;

  process.stdout.write('  Fetching orders... ');
  const { count, revenue, aov, rawOrders } = await getOrders(dayStart, dayEnd);
  console.log(`done (${count} orders, $${revenue} revenue)`);

  process.stdout.write('  Fetching abandoned checkouts... ');
  const { count: abandonedCount } = await getAbandonedCheckouts(dayStart, dayEnd);
  console.log(`done (${abandonedCount} abandoned)`);

  const topProducts = buildTopProducts(rawOrders);
  const cartAbandonmentRate = abandonedCount + count > 0
    ? Math.round((abandonedCount / (abandonedCount + count)) * 100) / 100
    : 0;

  const snapshot = {
    date,
    orders: { count, revenue, aov },
    abandonedCheckouts: { count: abandonedCount },
    cartAbandonmentRate,
    topProducts,
  };

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
}

main()
  .then(() => notify({ subject: 'Shopify Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }))
  .catch(err => {
    notify({ subject: 'Shopify Collector failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
```

- [ ] **Step 2: Run it and verify the snapshot**

```bash
node agents/shopify-collector/index.js
```

Expected output:
```
Shopify Collector

  Date: 2026-03-18
  Fetching orders... done (N orders, $X revenue)
  Fetching abandoned checkouts... done (N abandoned)
  Snapshot saved: data/snapshots/shopify/2026-03-18.json
```

Then verify:
```bash
node -e "const d=JSON.parse(require('fs').readFileSync('data/snapshots/shopify/2026-03-18.json','utf8')); console.log('orders:', d.orders, 'abandon rate:', d.cartAbandonmentRate)"
```

- [ ] **Step 3: Commit**

```bash
git add agents/shopify-collector/index.js
git commit -m "feat: add shopify-collector agent"
```

---

## Task 5: `agents/cro-analyzer/index.js`

**Files:**
- Create: `agents/cro-analyzer/index.js`

- [ ] **Step 1: Create `agents/cro-analyzer/index.js`**

```js
/**
 * CRO Analyzer Agent
 *
 * Reads the last 7 days of Clarity and Shopify snapshots, sends them to
 * Claude for CRO analysis, and saves a brief to:
 *   data/reports/cro/YYYY-MM-DD-cro-brief.md
 *
 * Usage:
 *   node agents/cro-analyzer/index.js
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CLARITY_DIR  = join(ROOT, 'data', 'snapshots', 'clarity');
const SHOPIFY_DIR  = join(ROOT, 'data', 'snapshots', 'shopify');
const REPORTS_DIR  = join(ROOT, 'data', 'reports', 'cro');

function loadRecentSnapshots(dir, days = 7) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse()
    .slice(0, days)
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

async function main() {
  console.log('CRO Analyzer\n');

  const claritySnaps  = loadRecentSnapshots(CLARITY_DIR);
  const shopifySnaps  = loadRecentSnapshots(SHOPIFY_DIR);

  console.log(`  Clarity snapshots:  ${claritySnaps.length}`);
  console.log(`  Shopify snapshots:  ${shopifySnaps.length}`);

  if (!claritySnaps.length && !shopifySnaps.length) {
    console.log('  No snapshot data found — run collectors first.');
    process.exit(0);
  }

  const env = loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY in .env');

  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are a senior CRO (conversion rate optimization) analyst. You will be given daily snapshot data from Microsoft Clarity (user behavior) and Shopify (orders, revenue, cart abandonment) for a small ecommerce store selling natural skin care and oral care products.

Your task: analyze the data, identify the most impactful CRO opportunities, and write a concise brief with 3-7 prioritized action items.

For each action item:
- Assign priority: HIGH, MED, or LOW
- State the specific metric and its value that drives the recommendation
- Give a concrete, specific action the store owner can take

Output format (Markdown):
## Summary
[2-3 sentence overview of the week's performance]

## Action Items

### 1. [SHORT TITLE] — [HIGH/MED/LOW]
**Evidence:** [specific metric + value]
**Action:** [concrete thing to do]

[repeat for each item]

## Raw Data
[paste key metrics as a compact table]`;

  const userMessage = `Here is the last ${claritySnaps.length} days of Clarity data and ${shopifySnaps.length} days of Shopify data:

### Clarity Snapshots (most recent first)
${JSON.stringify(claritySnaps, null, 2)}

### Shopify Snapshots (most recent first)
${JSON.stringify(shopifySnaps, null, 2)}

Write the CRO brief now.`;

  process.stdout.write('  Running AI analysis... ');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const brief = response.content[0].text;
  console.log('done');

  const today = new Date().toISOString().slice(0, 10);
  const header = `# CRO Brief — ${today}\n**Generated:** ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}\n\n---\n\n`;

  mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `${today}-cro-brief.md`);
  writeFileSync(outPath, header + brief);
  console.log(`  Brief saved: ${outPath}`);
}

main()
  .then(() => notify({ subject: 'CRO Analyzer completed', body: 'Weekly CRO brief generated.', status: 'success' }))
  .catch(err => {
    notify({ subject: 'CRO Analyzer failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
```

- [ ] **Step 2: Run it**

```bash
node agents/cro-analyzer/index.js
```

Expected output:
```
CRO Analyzer

  Clarity snapshots:  1
  Shopify snapshots:  1
  Running AI analysis... done
  Brief saved: data/reports/cro/2026-03-18-cro-brief.md
```

Then inspect the brief:
```bash
cat data/reports/cro/2026-03-18-cro-brief.md
```

Expected: Markdown with `## Summary`, `## Action Items` with HIGH/MED/LOW items, and `## Raw Data`.

- [ ] **Step 3: Commit**

```bash
git add agents/cro-analyzer/index.js
git commit -m "feat: add cro-analyzer agent with Claude-powered brief generation"
```

---

## Task 6: Dashboard — `parseCROData()` (server-side)

**Files:**
- Modify: `agents/dashboard/index.js`

Add the `parseCROData()` function to the server-side data aggregation, and include `cro` in the `aggregateData()` return object.

- [ ] **Step 1: Add `parseCROData()` after `parseRankings()` (around line 198)**

Find the line `// ── ahrefs data readiness` in `agents/dashboard/index.js` and insert before it:

```js
// ── CRO data ───────────────────────────────────────────────────────────────────

const CLARITY_SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'clarity');
const SHOPIFY_SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'shopify');
const CRO_REPORTS_DIR       = join(ROOT, 'data', 'reports', 'cro');

function parseCROData() {
  const empty = { clarity: null, shopify: null, brief: null, prevClarity: null, prevShopify: null };

  // Load latest + previous Clarity snapshot
  let clarityLatest = null, clarityPrev = null;
  if (existsSync(CLARITY_SNAPSHOTS_DIR)) {
    const files = readdirSync(CLARITY_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
    if (files[0]) clarityLatest = JSON.parse(readFileSync(join(CLARITY_SNAPSHOTS_DIR, files[0]), 'utf8'));
    if (files[1]) clarityPrev   = JSON.parse(readFileSync(join(CLARITY_SNAPSHOTS_DIR, files[1]), 'utf8'));
  }

  // Load latest + previous Shopify snapshot
  let shopifyLatest = null, shopifyPrev = null;
  if (existsSync(SHOPIFY_SNAPSHOTS_DIR)) {
    const files = readdirSync(SHOPIFY_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
    if (files[0]) shopifyLatest = JSON.parse(readFileSync(join(SHOPIFY_SNAPSHOTS_DIR, files[0]), 'utf8'));
    if (files[1]) shopifyPrev   = JSON.parse(readFileSync(join(SHOPIFY_SNAPSHOTS_DIR, files[1]), 'utf8'));
  }

  // Load most recent CRO brief
  let brief = null;
  if (existsSync(CRO_REPORTS_DIR)) {
    const files = readdirSync(CRO_REPORTS_DIR)
      .filter(f => f.endsWith('-cro-brief.md'))
      .sort().reverse();
    if (files[0]) {
      brief = {
        date: files[0].replace('-cro-brief.md', ''),
        content: readFileSync(join(CRO_REPORTS_DIR, files[0]), 'utf8'),
      };
    }
  }

  return { clarity: clarityLatest, prevClarity: clarityPrev, shopify: shopifyLatest, prevShopify: shopifyPrev, brief };
}
```

- [ ] **Step 2: Add `cro` to `aggregateData()` return**

Find the return statement in `aggregateData()`:

```js
  return {
    generatedAt: new Date().toISOString(),
    site:        { name: config.name },
    pipeline:    { counts: statusCounts, items: pipelineItems },
    rankings,
    posts,
    pendingAhrefsData,
  };
```

Change to:

```js
  return {
    generatedAt: new Date().toISOString(),
    site:        { name: config.name },
    pipeline:    { counts: statusCounts, items: pipelineItems },
    rankings,
    posts,
    pendingAhrefsData,
    cro: parseCROData(),
  };
```

- [ ] **Step 3: Verify server starts without error**

```bash
node agents/dashboard/index.js &
sleep 2
curl -s http://localhost:4242/api/data | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('cro keys:', Object.keys(d.cro || {}))"
kill %1
```

Expected: `cro keys: [ 'clarity', 'prevClarity', 'shopify', 'prevShopify', 'brief' ]`

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add parseCROData to dashboard aggregation"
```

---

## Task 7: Dashboard — Tab Navigation + CRO Tab HTML/CSS

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add tab nav CSS**

Find the CSS block in the HTML template (inside `<style>`). Add after the existing `.card` styles:

```css
  /* ── tabs ── */
  .tab-nav { display: flex; gap: 2px; border-bottom: 2px solid var(--border); margin-bottom: 24px; }
  .tab-btn { padding: 8px 20px; font-size: 13px; font-weight: 500; color: var(--muted); background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -2px; cursor: pointer; border-radius: 6px 6px 0 0; transition: all .15s; }
  .tab-btn:hover { color: var(--text); background: var(--bg); }
  .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); background: #eff6ff; font-weight: 600; }
  .tab-panel { display: none; }
  .tab-panel.active { display: contents; }

  /* ── cro ── */
  .cro-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .kpi-strip { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
  .kpi-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; text-align: center; box-shadow: var(--shadow); }
  .kpi-card.alert { background: #fef2f2; border-color: #fecaca; }
  .kpi-value { font-size: 22px; font-weight: 700; line-height: 1; }
  .kpi-label { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .kpi-delta { font-size: 11px; margin-top: 3px; font-weight: 500; }
  .kpi-delta.up   { color: var(--green); }
  .kpi-delta.down { color: var(--red); }
  .kpi-delta.flat { color: var(--muted); }
  .cro-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .cro-table td { padding: 6px 0; border-bottom: 1px solid var(--border); }
  .cro-table td:first-child { color: var(--muted); }
  .cro-table td:last-child { text-align: right; font-weight: 500; }
  .cro-sub { font-size: 10px; color: var(--muted); }
  .brief-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; }
  .brief-item { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 12px; }
  .brief-item-title { font-size: 11px; font-weight: 700; color: #c2410c; margin-bottom: 6px; }
  .brief-item-body { font-size: 11px; color: #78350f; line-height: 1.5; }
  .empty-state { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
```

- [ ] **Step 2: Add tab nav HTML**

Find `<main id="app">` in the HTML template and add the tab nav immediately after it:

```html
<div class="tab-nav">
  <button class="tab-btn active" onclick="switchTab('seo', this)">SEO</button>
  <button class="tab-btn" onclick="switchTab('cro', this)">CRO</button>
</div>
<div id="tab-seo" class="tab-panel active">
```

Then find the closing `</main>` tag and add the CRO panel wrapper just before it:

```html
</div><!-- /tab-seo -->
<div id="tab-cro" class="tab-panel">
  <div id="cro-kpi-strip" style="margin-bottom:16px"></div>
  <div class="cro-grid" style="margin-bottom:16px">
    <div id="cro-clarity-card"></div>
    <div id="cro-shopify-card"></div>
  </div>
  <div id="cro-brief-card"></div>
</div><!-- /tab-cro -->
```

- [ ] **Step 3: Add `switchTab` JS function**

In the client-side `<script>` block, add:

```js
function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}
```

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add tab nav and CRO tab shell to dashboard"
```

---

## Task 8: Dashboard — `renderCROTab()` Client-Side Function

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add `renderCROTab` to the client-side script**

Add after `renderPosts(data)` function call in the `loadData()` function, and define the function itself. Insert `renderCROTab(data);` inside `loadData()` after the existing render calls.

Then add the full render function:

```js
function renderCROTab(data) {
  const cro = data.cro || {};
  const cl  = cro.clarity  || null;
  const sh  = cro.shopify  || null;
  const pcl = cro.prevClarity  || null;
  const psh = cro.prevShopify  || null;

  // ── helpers ────────────────────────────────────────────────────────────────
  const fmt2 = v => v != null ? v.toFixed(2) : '—';
  const fmtPct = v => v != null ? v.toFixed(1) + '%' : '—';
  const fmtDollar = v => v != null ? '$' + fmtNum(Math.round(v)) : '—';
  const delta = (curr, prev, higherIsBetter = true) => {
    if (curr == null || prev == null) return '<span class="kpi-delta flat">—</span>';
    const diff = curr - prev;
    const dir = diff > 0 ? (higherIsBetter ? 'up' : 'down') : diff < 0 ? (higherIsBetter ? 'down' : 'up') : 'flat';
    const sign = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    const display = Math.abs(diff) < 1 ? Math.abs(diff).toFixed(2) : Math.round(Math.abs(diff));
    return `<span class="kpi-delta ${dir}">${sign} ${display}</span>`;
  };

  // Conversion rate = orders / real sessions (cross-source)
  const convRate  = (sh?.orders?.count != null && cl?.sessions?.real)
    ? (sh.orders.count / cl.sessions.real * 100) : null;
  const pConvRate = (psh?.orders?.count != null && pcl?.sessions?.real)
    ? (psh.orders.count / pcl.sessions.real * 100) : null;

  // ── KPI strip ──────────────────────────────────────────────────────────────
  const kpis = [
    { label: 'Conversion Rate', value: convRate != null ? fmtPct(convRate) : '—', d: delta(convRate, pConvRate), alert: false },
    { label: 'Avg Order Value', value: sh ? fmtDollar(sh.orders.aov) : '—', d: delta(sh?.orders?.aov, psh?.orders?.aov), alert: false },
    { label: 'Real Sessions',   value: cl ? cl.sessions.real : '—',
      sub: cl ? `of ${cl.sessions.total} total` : '', d: delta(cl?.sessions?.real, pcl?.sessions?.real), alert: false },
    { label: 'Script Errors',   value: cl ? fmtPct(cl.behavior.scriptErrorPct) : '—',
      d: delta(cl?.behavior?.scriptErrorPct, pcl?.behavior?.scriptErrorPct, false),
      alert: cl?.behavior?.scriptErrorPct > 5 },
    { label: 'Scroll Depth',    value: cl ? fmtPct(cl.behavior.scrollDepth) : '—',
      d: delta(cl?.behavior?.scrollDepth, pcl?.behavior?.scrollDepth), alert: false },
    { label: 'Cart Abandon',    value: sh ? fmtPct(sh.cartAbandonmentRate * 100) : '—',
      d: delta(sh?.cartAbandonmentRate, psh?.cartAbandonmentRate, false), alert: false },
  ];

  document.getElementById('cro-kpi-strip').innerHTML =
    '<div class="kpi-strip">' +
    kpis.map(k =>
      `<div class="kpi-card${k.alert ? ' alert' : ''}">` +
      `<div class="kpi-value">${k.value}</div>` +
      `<div class="kpi-label">${k.label}</div>` +
      (k.sub ? `<div class="cro-sub">${k.sub}</div>` : '') +
      k.d +
      '</div>'
    ).join('') +
    '</div>';

  // ── Clarity card ───────────────────────────────────────────────────────────
  const clarityHtml = cl ? (
    '<div class="card">' +
    '<div class="card-header"><h2>Clarity</h2><span style="font-size:11px;color:var(--muted)">' + esc(cl.date) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Total Sessions</td><td>' + cl.sessions.total + ' <span class="cro-sub">(' + cl.sessions.bots + ' bots)</span></td></tr>' +
    '<tr><td>Active Engagement</td><td>' + cl.engagement.activeTime + 's <span class="cro-sub">of ' + cl.engagement.totalTime + 's</span></td></tr>' +
    '<tr><td>Device Split</td><td>' + (cl.devices[0] ? cl.devices[0].name + ': ' + cl.devices[0].sessions : '—') + '</td></tr>' +
    '<tr><td>Top Country</td><td>' + (cl.countries[0] ? esc(cl.countries[0].name) + ' (' + cl.countries[0].sessions + ')' : '—') + '</td></tr>' +
    '<tr><td>Rage Clicks</td><td>' + fmtPct(cl.behavior.rageClickPct) + '</td></tr>' +
    '<tr><td>Dead Clicks</td><td>' + fmtPct(cl.behavior.deadClickPct) + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Pages</div>' +
    cl.topPages.slice(0, 5).map((p, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + (i+1) + '. ' + esc(p.title.length > 50 ? p.title.slice(0,50)+'…' : p.title) + ' — ' + p.sessions + '</div>'
    ).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No Clarity data collected yet — run clarity-collector to get started.</p></div></div>';

  document.getElementById('cro-clarity-card').innerHTML = clarityHtml;

  // ── Shopify card ───────────────────────────────────────────────────────────
  const shopifyHtml = sh ? (
    '<div class="card">' +
    '<div class="card-header"><h2>Shopify</h2><span style="font-size:11px;color:var(--muted)">' + esc(sh.date) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Revenue</td><td>' + fmtDollar(sh.orders.revenue) + '</td></tr>' +
    '<tr><td>Orders</td><td>' + sh.orders.count + '</td></tr>' +
    '<tr><td>Avg Order Value</td><td>' + fmtDollar(sh.orders.aov) + '</td></tr>' +
    '<tr><td>Abandoned Carts</td><td>' + sh.abandonedCheckouts.count + '</td></tr>' +
    '<tr><td>Cart Abandon Rate</td><td>' + fmtPct(sh.cartAbandonmentRate * 100) + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Products</div>' +
    sh.topProducts.slice(0, 5).map((p, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + (i+1) + '. ' + esc(p.title) + ' — ' + fmtDollar(p.revenue) + ' (' + p.orders + ' orders)</div>'
    ).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No Shopify data collected yet — run shopify-collector to get started.</p></div></div>';

  document.getElementById('cro-shopify-card').innerHTML = shopifyHtml;

  // ── CRO Brief ──────────────────────────────────────────────────────────────
  const brief = cro.brief;
  let briefHtml;
  if (!brief) {
    briefHtml = '<div class="card"><div class="card-body"><p class="empty-state">No brief generated yet — run cro-analyzer to generate your first brief.</p></div></div>';
  } else {
    // Parse action items from markdown (lines starting with ### N.)
    const items = [];
    const lines = brief.content.split('\n');
    let current = null;
    for (const line of lines) {
      if (/^### \d+\./.test(line)) {
        if (current) items.push(current);
        const titleMatch = line.match(/^### \d+\.\s+(.+?)\s+—\s+(HIGH|MED|LOW)/i);
        current = { title: titleMatch?.[1] || line.replace(/^### \d+\.\s*/, ''), priority: titleMatch?.[2] || '', body: [] };
      } else if (current && line.trim() && !/^##/.test(line)) {
        current.body.push(line.trim());
      }
    }
    if (current) items.push(current);

    const prioColor = p => p === 'HIGH' ? '#dc2626' : p === 'MED' ? '#d97706' : '#6b7280';

    briefHtml = '<div class="card" style="background:#fffbeb;border-color:#fde68a">' +
      '<div class="card-header"><h2 style="color:#92400e">AI CRO Brief</h2>' +
      '<span style="font-size:11px;color:#92400e">Generated ' + esc(brief.date) + ' · Next run: Every Monday</span></div>' +
      '<div class="card-body">' +
      (items.length ? '<div class="brief-grid">' +
        items.slice(0, 6).map(item =>
          '<div class="brief-item">' +
          '<div class="brief-item-title" style="color:' + prioColor(item.priority) + '">' +
          (item.priority ? item.priority + ' — ' : '') + esc(item.title) + '</div>' +
          '<div class="brief-item-body">' + esc(item.body.slice(0, 3).join(' ').slice(0, 200)) + '</div>' +
          '</div>'
        ).join('') + '</div>'
      : '<pre style="font-size:11px;white-space:pre-wrap;color:#78350f">' + esc(brief.content.slice(0, 1000)) + '</pre>') +
      '</div></div>';
  }

  document.getElementById('cro-brief-card').innerHTML = briefHtml;
}
```

- [ ] **Step 2: Call `renderCROTab` inside `loadData()`**

Find `renderPosts(data);` in the `loadData()` function and add after it:

```js
renderCROTab(data);
```

- [ ] **Step 3: Run the dashboard and verify CRO tab renders**

```bash
node agents/dashboard/index.js &
sleep 2
open http://localhost:4242
```

- Click the **CRO** tab — it should show the KPI strip, Clarity card, Shopify card, and AI brief.
- Click **SEO** tab — existing content should still render correctly.
- Kill the server: `kill %1`

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add CRO tab rendering to dashboard"
```

---

## Task 9: Push and Deploy

- [ ] **Step 1: Push to GitHub**

```bash
git push
```

- [ ] **Step 2: Pull on server and restart dashboard**

SSH into the server and run:

```bash
cd /root/seo-claude && git pull && pm2 restart seo-dashboard
```

- [ ] **Step 3: Add cron entries on the server**

```bash
crontab -e
```

Add these lines (adjust path and node path as needed, following the pattern of existing cron entries):

```
# CRO collectors — daily at 6am PT
0 13 * * * cd /root/seo-claude && /root/.nvm/versions/node/*/bin/node agents/clarity-collector/index.js >> /root/seo-claude/logs/clarity-collector.log 2>&1
0 13 * * * cd /root/seo-claude && /root/.nvm/versions/node/*/bin/node agents/shopify-collector/index.js >> /root/seo-claude/logs/shopify-collector.log 2>&1

# CRO analyzer — weekly Monday at 7am PT
0 14 * * 1 cd /root/seo-claude && /root/.nvm/versions/node/*/bin/node agents/cro-analyzer/index.js >> /root/seo-claude/logs/cro-analyzer.log 2>&1
```

Check the existing crontab entries to get the exact node binary path used by other agents.

- [ ] **Step 4: Run collectors manually on server to populate first snapshots**

```bash
cd /root/seo-claude
node agents/clarity-collector/index.js
node agents/shopify-collector/index.js
node agents/cro-analyzer/index.js
```

Then commit the generated snapshot files back to git:

```bash
git add data/snapshots/ data/reports/cro/
git commit -m "feat: initial CRO snapshots and brief"
git push
```
