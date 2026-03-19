# GA4 + GSC Dashboard Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Analytics 4 and Google Search Console as daily snapshot sources, feed them into the CRO brief and dashboard (CRO tab 2×2 grid, SEO tab GSC panel).

**Architecture:** Daily collector agents save JSON snapshots to `data/snapshots/gsc/` and `data/snapshots/ga4/`; `lib/ga4.js` wraps the Analytics Data API v1 using the same OAuth2 refresh token pattern as `lib/gsc.js`; `lib/gsc.js` gains two new single-day query methods; the CRO analyzer and dashboard both read from all four snapshot sources.

**Tech Stack:** Node.js ESM, Google Search Console API v3, Google Analytics Data API v1beta, existing `lib/gsc.js` OAuth2 pattern, `@anthropic-ai/sdk` (already installed).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/gsc.js` | Modify | Add `getKeywordsForDate(date, limit)` and `getPagesForDate(date, limit)` |
| `lib/ga4.js` | Create | GA4 Analytics Data API v1 client — `fetchGA4Snapshot(date)` |
| `scripts/reauth-google.js` | Create | One-time OAuth re-auth with both GSC + GA4 scopes |
| `scripts/gsc-auth.js` | Modify | Add `analytics.readonly` scope so re-runs don't downgrade token |
| `agents/gsc-collector/index.js` | Create | Daily agent: GSC snapshot → `data/snapshots/gsc/YYYY-MM-DD.json` |
| `agents/ga4-collector/index.js` | Create | Daily agent: GA4 snapshot → `data/snapshots/ga4/YYYY-MM-DD.json` |
| `agents/cro-analyzer/index.js` | Modify | Load GSC + GA4 snapshots; update early-exit guard; extend prompt |
| `agents/dashboard/index.js` | Modify | parseCROData() + aggregates + SEO tab GSC panel + CRO tab 2×2 + KPI strip |
| `scripts/setup-cron.sh` | Modify | Add gsc-collector (15 13 * * *) and ga4-collector (20 13 * * *) |

---

## Task 1: Add single-day query methods to `lib/gsc.js`

**Files:**
- Modify: `lib/gsc.js` (append after line 380)

The existing `gscQuery()` internal helper already accepts arbitrary date ranges — we just need two new exported methods that pass `[date, date]` instead of a rolling window. Note: the raw API uses `r.keys[0]` for dimension values — the new methods name the output field `query` (not `keyword` like the existing methods, to match the snapshot schema).

- [ ] **Step 1: Append the two new methods to `lib/gsc.js`**

Add after the last export (`getSearchTrend`):

```js
/**
 * getKeywordsForDate(date, limit)
 * Top queries by clicks for a single specific date (YYYY-MM-DD).
 * Note: GSC data lags ~3 days — pass a date 3 days in the past.
 * Returns: [{ query, clicks, impressions, ctr, position }]
 */
export async function getKeywordsForDate(date, limit = 10) {
  const rows = await gscQuery({
    startDate: date,
    endDate: date,
    dimensions: ['query'],
    rowLimit: limit,
    orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
  });
  return rows.map(r => ({
    query: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

/**
 * getPagesForDate(date, limit)
 * Top pages by clicks for a single specific date (YYYY-MM-DD).
 * Returns: [{ page, clicks, impressions, ctr, position }]
 */
export async function getPagesForDate(date, limit = 10) {
  const rows = await gscQuery({
    startDate: date,
    endDate: date,
    dimensions: ['page'],
    rowLimit: limit,
    orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
  });
  return rows.map(r => ({
    page: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check lib/gsc.js
```
Expected: no output (no errors)

- [ ] **Step 3: Smoke-test against live GSC API**

Use a date 3–5 days ago to ensure data exists:

```bash
node -e "import('./lib/gsc.js').then(m => m.getKeywordsForDate('2026-03-13', 3)).then(r => console.log(JSON.stringify(r, null, 2)))"
```
Expected: array of up to 3 objects with `query`, `clicks`, `impressions`, `ctr`, `position` fields. May be empty if no GSC data for that date (fine — that's what the early-exit guard in the collector handles).

- [ ] **Step 4: Commit**

```bash
git add lib/gsc.js
git commit -m "feat: add getKeywordsForDate and getPagesForDate to lib/gsc.js"
```

---

## Task 2: Create `lib/ga4.js`

**Files:**
- Create: `lib/ga4.js`

Follows the exact same OAuth2 pattern as `lib/gsc.js`. Requires `GOOGLE_ANALYTICS_PROPERTY_ID` and the existing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` in `.env`. Makes three `runReport` API calls: one for daily session summary, one for traffic sources by session source + medium, one for top landing pages.

**Important:** This will return HTTP 403 until `GOOGLE_ANALYTICS_PROPERTY_ID` is in `.env` and the refresh token has `analytics.readonly` scope (done in Task 3). That's expected — the file should still parse and import correctly.

- [ ] **Step 1: Create `lib/ga4.js`**

```js
/**
 * Google Analytics 4 — Analytics Data API v1 client
 *
 * Uses the same OAuth2 refresh token as lib/gsc.js.
 * Required .env keys:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN       (must include analytics.readonly scope — run scripts/reauth-google.js)
 *   GOOGLE_ANALYTICS_PROPERTY_ID  (e.g. 358754048)
 *
 * Exports: fetchGA4Snapshot(date)  →  normalized GA4 snapshot object
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
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
}

const env = loadEnv();
const CLIENT_ID     = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = env.GOOGLE_REFRESH_TOKEN;
const PROPERTY_ID   = env.GOOGLE_ANALYTICS_PROPERTY_ID;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  throw new Error('Missing Google OAuth credentials in .env. Run: node scripts/reauth-google.js');
}
if (!PROPERTY_ID) {
  throw new Error('Missing GOOGLE_ANALYTICS_PROPERTY_ID in .env (e.g. 358754048)');
}

// ── token management (same pattern as lib/gsc.js) ─────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GA4 token refresh failed: HTTP ${res.status} — ${text}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── core request ──────────────────────────────────────────────────────────────

async function runReport(body) {
  const token = await getAccessToken();
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GA4 API error: HTTP ${res.status} — ${text}`);
  }
  return res.json();
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * fetchGA4Snapshot(date)
 * Fetches session summary, traffic sources, and top landing pages for a single date.
 * Returns a normalized GA4 snapshot object matching the spec schema.
 */
export async function fetchGA4Snapshot(date) {
  const dateRange = { startDate: date, endDate: date };

  // Call 1: session-level summary (no dimensions)
  const summaryReport = await runReport({
    dateRanges: [dateRange],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'bounceRate' },
      { name: 'averageSessionDuration' },
      { name: 'conversions' },
      { name: 'sessionConversionRate' },
      { name: 'totalRevenue' },
    ],
  });

  const sumRow = summaryReport.rows?.[0]?.metricValues ?? [];
  const parse = (i) => parseFloat(sumRow[i]?.value ?? '0');

  const sessions          = Math.round(parse(0));
  const users             = Math.round(parse(1));
  const newUsers          = Math.round(parse(2));
  const bounceRate        = Math.round(parse(3) * 1000) / 1000;  // 3 decimal places
  const avgSessionDuration = Math.round(parse(4));                 // seconds, integer
  const conversions       = Math.round(parse(5));
  const conversionRate    = Math.round(parse(6) * 1000) / 1000;
  const revenue           = Math.round(parse(7) * 100) / 100;

  // Call 2: traffic sources
  const sourcesReport = await runReport({
    dateRanges: [dateRange],
    dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
    metrics: [
      { name: 'sessions' },
      { name: 'conversions' },
      { name: 'totalRevenue' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 5,
  });

  const topSources = (sourcesReport.rows || []).map(row => ({
    source:      row.dimensionValues[0].value,
    medium:      row.dimensionValues[1].value,
    sessions:    Math.round(parseFloat(row.metricValues[0].value)),
    conversions: Math.round(parseFloat(row.metricValues[1].value)),
    revenue:     Math.round(parseFloat(row.metricValues[2].value) * 100) / 100,
  }));

  // Call 3: top landing pages
  const pagesReport = await runReport({
    dateRanges: [dateRange],
    dimensions: [{ name: 'landingPage' }],
    metrics: [
      { name: 'sessions' },
      { name: 'conversions' },
      { name: 'totalRevenue' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 5,
  });

  const topLandingPages = (pagesReport.rows || []).map(row => ({
    page:        row.dimensionValues[0].value,
    sessions:    Math.round(parseFloat(row.metricValues[0].value)),
    conversions: Math.round(parseFloat(row.metricValues[1].value)),
    revenue:     Math.round(parseFloat(row.metricValues[2].value) * 100) / 100,
  }));

  return {
    date,
    sessions,
    users,
    newUsers,
    bounceRate,
    avgSessionDuration,
    conversions,
    conversionRate,
    revenue,
    topSources,
    topLandingPages,
  };
}
```

- [ ] **Step 2: Add `GOOGLE_ANALYTICS_PROPERTY_ID` to `.env`**

```bash
# Append to .env (run this or edit manually)
echo "GOOGLE_ANALYTICS_PROPERTY_ID=358754048" >> .env
```

- [ ] **Step 3: Verify syntax**

```bash
node --check lib/ga4.js
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add lib/ga4.js .env
git commit -m "feat: add lib/ga4.js — GA4 Analytics Data API v1 client"
```

---

## Task 3: OAuth re-authorization + update `scripts/gsc-auth.js`

**Files:**
- Create: `scripts/reauth-google.js`
- Modify: `scripts/gsc-auth.js` line 33

The existing `GOOGLE_REFRESH_TOKEN` only has `webmasters.readonly` scope. GA4 needs `analytics.readonly` added. `reauth-google.js` is a copy of `gsc-auth.js` with two differences: the `SCOPES` constant includes both scopes, and the success message mentions both APIs. Also update `gsc-auth.js` to use both scopes so future re-runs don't silently downgrade the token.

- [ ] **Step 1: Update `scripts/gsc-auth.js` scope constant (line 33)**

Change:
```js
const SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly';
```
To:
```js
const SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly';
```

- [ ] **Step 2: Create `scripts/reauth-google.js`**

This is `gsc-auth.js` with updated scopes and messaging:

```js
#!/usr/bin/env node
/**
 * Google OAuth re-authorization — adds analytics.readonly scope
 *
 * Run this once to add GA4 access to the existing Google refresh token.
 * Updates GOOGLE_REFRESH_TOKEN in .env with a token that grants both:
 *   - webmasters.readonly  (Google Search Console)
 *   - analytics.readonly   (Google Analytics 4)
 *
 * Prerequisites: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET must be in .env
 *
 * Usage: node scripts/reauth-google.js
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');

const PORT = 3458;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
].join(' ');

function loadEnv() {
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

function saveToEnv(key, value) {
  let content = readFileSync(ENV_PATH, 'utf8');
  const regex = new RegExp(`^${key}=.*`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, content);
}

const env = loadEnv();
const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent` +
  `&state=${state}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.writeHead(404); res.end('Not found'); return; }

  const params = Object.fromEntries(url.searchParams.entries());
  if (params.state !== state) {
    res.writeHead(400); res.end('State mismatch.');
    server.close(); process.exit(1);
  }
  if (params.error) {
    res.writeHead(400); res.end(`OAuth error: ${params.error}`);
    console.error('OAuth error:', params.error);
    server.close(); process.exit(1);
  }
  if (!params.code) {
    res.writeHead(400); res.end('No authorization code returned.');
    server.close(); process.exit(1);
  }

  console.log('\nExchanging code for tokens...');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: params.code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`Token exchange failed: HTTP ${tokenRes.status} — ${text}`);
    }
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      throw new Error('No refresh_token returned. Try revoking access at myaccount.google.com/permissions and re-running.');
    }
    saveToEnv('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Success!</h2><p>GSC + GA4 authorized. You can close this tab.</p>');
    console.log('✓ Refresh token saved to .env (grants webmasters.readonly + analytics.readonly)');
    console.log('\nTest GA4: node -e "import(\'./lib/ga4.js\').then(m => m.fetchGA4Snapshot(\'2026-03-18\')).then(r => console.log(JSON.stringify(r, null, 2)))"');
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500); res.end(`Error: ${err.message}`);
    console.error('Error:', err.message);
    server.close(); process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\nGoogle OAuth — opening browser for GSC + GA4 authorization...\n');
  console.log('Scopes:', SCOPES);
  console.log('Callback:', REDIRECT_URI, '\n');
  try { execSync(`open "${authUrl}"`); }
  catch { console.log('Could not open browser. Visit this URL manually:\n\n' + authUrl); }
  console.log('\nWaiting for Google callback...');
});
```

- [ ] **Step 3: Run re-authorization**

```bash
node scripts/reauth-google.js
```

A browser window will open. Log in, approve both scopes. When the terminal shows "✓ Refresh token saved", the `.env` `GOOGLE_REFRESH_TOKEN` has been updated.

- [ ] **Step 4: Verify GA4 access**

```bash
node -e "import('./lib/ga4.js').then(m => m.fetchGA4Snapshot('2026-03-18')).then(r => console.log(JSON.stringify(r, null, 2)))"
```
Expected: a JSON object with `sessions`, `users`, `revenue`, `topSources`, `topLandingPages` fields.

- [ ] **Step 5: Verify GSC still works**

```bash
node -e "import('./lib/gsc.js').then(m => m.getKeywordsForDate('2026-03-13', 3)).then(r => console.log(r))"
```
Expected: array of query objects (not an auth error).

- [ ] **Step 6: Commit**

```bash
git add scripts/reauth-google.js scripts/gsc-auth.js
git commit -m "feat: add reauth-google.js for GSC+GA4 scopes; update gsc-auth.js scopes"
```

---

## Task 4: Create `agents/gsc-collector/index.js`

**Files:**
- Create: `agents/gsc-collector/index.js`

Follow the shopify-collector pattern exactly. Default date = 3 days ago in PT (to account for GSC data lag). Use `getKeywordsForDate` and `getPagesForDate` from `lib/gsc.js`. Compute summary stats from the returned rows.

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p agents/gsc-collector
```

```js
/**
 * GSC Collector Agent
 *
 * Fetches Google Search Console data for a specific date and saves a snapshot to:
 *   data/snapshots/gsc/YYYY-MM-DD.json
 *
 * Default date is 3 days ago (Pacific time) to account for GSC's data lag.
 *
 * Usage:
 *   node agents/gsc-collector/index.js
 *   node agents/gsc-collector/index.js --date 2026-03-15
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getKeywordsForDate, getPagesForDate } from '../../lib/gsc.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'gsc');

// Default: 3 days ago in Pacific time (matches GSC data lag)
function defaultDate() {
  return new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
const date = dateArg || defaultDate();

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Invalid date format. Expected YYYY-MM-DD.');
  process.exit(1);
}

async function main() {
  console.log('GSC Collector\n');
  console.log(`  Date: ${date}`);

  process.stdout.write('  Fetching top queries... ');
  const topQueries = await getKeywordsForDate(date, 10);
  console.log(`done (${topQueries.length} queries)`);

  process.stdout.write('  Fetching top pages... ');
  const topPages = await getPagesForDate(date, 10);
  console.log(`done (${topPages.length} pages)`);

  if (!topQueries.length && !topPages.length) {
    console.log('  No GSC data for this date (may still be within lag window) — skipping snapshot.');
    return false;
  }

  // Compute summary from query-level data (GSC returns weighted aggregates per query)
  const totalClicks      = topQueries.reduce((s, r) => s + r.clicks, 0);
  const totalImpressions = topQueries.reduce((s, r) => s + r.impressions, 0);
  const weightedCtr      = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const weightedPosition = totalImpressions > 0
    ? topQueries.reduce((s, r) => s + r.position * r.impressions, 0) / totalImpressions
    : 0;

  const snapshot = {
    date,
    summary: {
      clicks:      totalClicks,
      impressions: totalImpressions,
      ctr:         Math.round(weightedCtr * 10000) / 10000,
      position:    Math.round(weightedPosition * 10) / 10,
    },
    topQueries,
    topPages,
  };

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
  return true;
}

main()
  .then(async (saved) => {
    if (saved) {
      await notify({ subject: 'GSC Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }).catch(() => {});
    }
  })
  .catch(async err => {
    await notify({ subject: 'GSC Collector failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
```

- [ ] **Step 2: Run collector to verify it works**

```bash
node agents/gsc-collector/index.js
```
Expected output:
```
GSC Collector

  Date: 2026-03-15
  Fetching top queries... done (10 queries)
  Fetching top pages... done (10 pages)
  Snapshot saved: data/snapshots/gsc/2026-03-15.json
```

- [ ] **Step 3: Verify snapshot file**

```bash
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('data/snapshots/gsc/2026-03-15.json')), null, 2))"
```
Expected: valid JSON matching the schema with `date`, `summary`, `topQueries`, `topPages` fields.

- [ ] **Step 4: Commit**

```bash
git add agents/gsc-collector/index.js data/snapshots/gsc/
git commit -m "feat: add gsc-collector agent with daily GSC snapshot"
```

---

## Task 5: Create `agents/ga4-collector/index.js`

**Files:**
- Create: `agents/ga4-collector/index.js`

Same pattern as gsc-collector. Default date = today in Pacific time. No early-exit for zero sessions — write the snapshot regardless (zero-session days are valid data for trend comparison).

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p agents/ga4-collector
```

```js
/**
 * GA4 Collector Agent
 *
 * Fetches Google Analytics 4 data for a specific date and saves a snapshot to:
 *   data/snapshots/ga4/YYYY-MM-DD.json
 *
 * Usage:
 *   node agents/ga4-collector/index.js
 *   node agents/ga4-collector/index.js --date 2026-03-18
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchGA4Snapshot } from '../../lib/ga4.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'ga4');

const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
const date = dateArg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Invalid date format. Expected YYYY-MM-DD.');
  process.exit(1);
}

async function main() {
  console.log('GA4 Collector\n');
  console.log(`  Date: ${date}`);

  process.stdout.write('  Fetching GA4 snapshot... ');
  const snapshot = await fetchGA4Snapshot(date);
  console.log(`done (${snapshot.sessions} sessions, ${snapshot.conversions} conversions, $${snapshot.revenue} revenue)`);

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
}

main()
  .then(async () => {
    await notify({ subject: 'GA4 Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }).catch(() => {});
  })
  .catch(async err => {
    await notify({ subject: 'GA4 Collector failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
```

- [ ] **Step 2: Run collector to verify it works**

```bash
node agents/ga4-collector/index.js
```
Expected:
```
GA4 Collector

  Date: 2026-03-18
  Fetching GA4 snapshot... done (143 sessions, 8 conversions, $387.42 revenue)
  Snapshot saved: data/snapshots/ga4/2026-03-18.json
```

- [ ] **Step 3: Commit**

```bash
git add agents/ga4-collector/index.js data/snapshots/ga4/
git commit -m "feat: add ga4-collector agent with daily GA4 snapshot"
```

---

## Task 6: Update `agents/cro-analyzer/index.js`

**Files:**
- Modify: `agents/cro-analyzer/index.js`

Three changes: (1) add GSC + GA4 snapshot dirs; (2) update early-exit guard from "both Clarity AND Shopify empty" to "all four sources empty"; (3) extend user message to include GSC and GA4 sections when present; (4) update system prompt to mention the new sources.

- [ ] **Step 1: Add directory constants after line 22**

Current lines 20–22:
```js
const ROOT = join(__dirname, '..', '..');
const CLARITY_DIR  = join(ROOT, 'data', 'snapshots', 'clarity');
const SHOPIFY_DIR  = join(ROOT, 'data', 'snapshots', 'shopify');
const REPORTS_DIR  = join(ROOT, 'data', 'reports', 'cro');
```

Change to:
```js
const ROOT = join(__dirname, '..', '..');
const CLARITY_DIR  = join(ROOT, 'data', 'snapshots', 'clarity');
const SHOPIFY_DIR  = join(ROOT, 'data', 'snapshots', 'shopify');
const GSC_DIR      = join(ROOT, 'data', 'snapshots', 'gsc');
const GA4_DIR      = join(ROOT, 'data', 'snapshots', 'ga4');
const REPORTS_DIR  = join(ROOT, 'data', 'reports', 'cro');
```

- [ ] **Step 2: Load GSC + GA4 snapshots and update early-exit guard**

Current lines 51–60:
```js
  const claritySnaps  = loadRecentSnapshots(CLARITY_DIR);
  const shopifySnaps  = loadRecentSnapshots(SHOPIFY_DIR);

  console.log(`  Clarity snapshots:  ${claritySnaps.length}`);
  console.log(`  Shopify snapshots:  ${shopifySnaps.length}`);

  if (!claritySnaps.length && !shopifySnaps.length) {
    console.log('  No snapshot data found — run collectors first.');
    process.exit(0);
  }
```

Change to:
```js
  const claritySnaps  = loadRecentSnapshots(CLARITY_DIR);
  const shopifySnaps  = loadRecentSnapshots(SHOPIFY_DIR);
  const gscSnaps      = loadRecentSnapshots(GSC_DIR);
  const ga4Snaps      = loadRecentSnapshots(GA4_DIR);

  console.log(`  Clarity snapshots:  ${claritySnaps.length}`);
  console.log(`  Shopify snapshots:  ${shopifySnaps.length}`);
  console.log(`  GSC snapshots:      ${gscSnaps.length}`);
  console.log(`  GA4 snapshots:      ${ga4Snaps.length}`);

  if (!claritySnaps.length && !shopifySnaps.length && !gscSnaps.length && !ga4Snaps.length) {
    console.log('  No snapshot data found — run collectors first.');
    process.exit(0);
  }
```

- [ ] **Step 3: Update system prompt to mention all four sources**

Current system prompt starts with:
```js
  const systemPrompt = `You are a senior CRO (conversion rate optimization) analyst. You will be given daily snapshot data from Microsoft Clarity (user behavior) and Shopify (orders, revenue, cart abandonment) for a small ecommerce store selling natural skin care and oral care products.
```

Change to:
```js
  const systemPrompt = `You are a senior CRO (conversion rate optimization) analyst. You will be given daily snapshot data from up to four sources for a small ecommerce store selling natural skin care and oral care products:
- Microsoft Clarity: user behavior (sessions, scroll depth, rage clicks, dead clicks)
- Shopify: orders, revenue, cart abandonment, top products
- Google Search Console (GSC): organic search queries, impressions, CTR, ranking positions
- Google Analytics 4 (GA4): sessions, bounce rate, conversion rate, revenue, traffic sources, top landing pages

Not all sources may be present — analyze what is available.
```

- [ ] **Step 4: Extend user message to include GSC and GA4**

Current user message (lines 92–100):
```js
  const userMessage = `Here is the last ${claritySnaps.length} days of Clarity data and ${shopifySnaps.length} days of Shopify data:

### Clarity Snapshots (most recent first)
${JSON.stringify(claritySnaps, null, 2)}

### Shopify Snapshots (most recent first)
${JSON.stringify(shopifySnaps, null, 2)}

Write the CRO brief now.`;
```

Change to:
```js
  const parts = [
    `Here is the available CRO data (most recent first):`,
    claritySnaps.length ? `### Clarity Snapshots (${claritySnaps.length} days)\n${JSON.stringify(claritySnaps, null, 2)}` : '',
    shopifySnaps.length ? `### Shopify Snapshots (${shopifySnaps.length} days)\n${JSON.stringify(shopifySnaps, null, 2)}` : '',
    gscSnaps.length     ? `### GSC Snapshots (${gscSnaps.length} days)\n${JSON.stringify(gscSnaps, null, 2)}`     : '',
    ga4Snaps.length     ? `### GA4 Snapshots (${ga4Snaps.length} days)\n${JSON.stringify(ga4Snaps, null, 2)}`     : '',
    `Write the CRO brief now.`,
  ].filter(Boolean);
  const userMessage = parts.join('\n\n');
```

- [ ] **Step 5: Run analyzer to verify it works with all four sources**

```bash
node agents/cro-analyzer/index.js
```
Expected: shows counts for all four sources, runs analysis, saves brief.

- [ ] **Step 6: Commit**

```bash
git add agents/cro-analyzer/index.js
git commit -m "feat: extend cro-analyzer to include GSC and GA4 snapshot sources"
```

---

## Task 7: Dashboard — server-side data + client aggregate helpers

**Files:**
- Modify: `agents/dashboard/index.js`

Two changes: (1) server-side `parseCROData()` — add `gscAll` and `ga4All` arrays; (2) client-side script — add `aggregateGSC()` and `aggregateGA4()` functions and extend the filter selection logic in `renderCROTab`.

**CRITICAL:** All client-side JS lives inside `const HTML = \`...\`` (a Node.js template literal). Any backtick or `\n` (backslash-n) inside the `<script>` block must be escaped as `\`` and `\\n`. Failing to do this causes the server to crash with a syntax error on startup.

- [ ] **Step 1: Extend `parseCROData()` to load GSC and GA4 snapshot arrays**

Current `parseCROData` return (line ~239):
```js
  return { clarityAll, shopifyAll, brief };
```

Before that return, add after the `shopifyAll` loading block (after line ~223):
```js
  // Load up to 60 GSC snapshots
  let gscAll = [];
  if (existsSync(GSC_SNAPSHOTS_DIR)) {
    const files = readdirSync(GSC_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 60);
    gscAll = files.map(f => JSON.parse(readFileSync(join(GSC_SNAPSHOTS_DIR, f), 'utf8')));
  }

  // Load up to 60 GA4 snapshots
  let ga4All = [];
  if (existsSync(GA4_SNAPSHOTS_DIR)) {
    const files = readdirSync(GA4_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 60);
    ga4All = files.map(f => JSON.parse(readFileSync(join(GA4_SNAPSHOTS_DIR, f), 'utf8')));
  }
```

And add the two directory constants alongside the existing ones (near line 202):
```js
const GSC_SNAPSHOTS_DIR  = join(ROOT, 'data', 'snapshots', 'gsc');
const GA4_SNAPSHOTS_DIR  = join(ROOT, 'data', 'snapshots', 'ga4');
```

And update the return:
```js
  return { clarityAll, shopifyAll, gscAll, ga4All, brief };
```

- [ ] **Step 2: Add `aggregateGSC()` and `aggregateGA4()` to the client script**

Add these two functions inside the `<script>` block, after the existing `aggregateShopify` function and before `renderCROTab`. Remember: no backticks, no `\n` inside.

```js
function aggregateGSC(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const totalClicks      = snaps.reduce((s, x) => s + (x.summary?.clicks || 0), 0);
  const totalImpressions = snaps.reduce((s, x) => s + (x.summary?.impressions || 0), 0);
  // Accumulate query-level data to compute weighted position from raw per-query data
  // (more accurate than weighting per-day summary positions)
  const queryMap = {};
  snaps.forEach(x => (x.topQueries || []).forEach(q => {
    if (!queryMap[q.query]) queryMap[q.query] = { clicks: 0, impressions: 0, posWt: 0 };
    queryMap[q.query].clicks      += q.clicks || 0;
    queryMap[q.query].impressions += q.impressions || 0;
    queryMap[q.query].posWt       += (q.position || 0) * (q.impressions || 0);
  }));
  const topQueries = Object.entries(queryMap)
    .sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 10)
    .map(([query, v]) => ({
      query, clicks: v.clicks, impressions: v.impressions,
      ctr:      v.impressions > 0 ? Math.round(v.clicks / v.impressions * 10000) / 10000 : 0,
      position: v.impressions > 0 ? Math.round(v.posWt / v.impressions * 10) / 10 : null,
    }));
  // Derive summary position from accumulated query posWt (weighted by impressions)
  const qTotalImpressions = Object.values(queryMap).reduce((s, v) => s + v.impressions, 0);
  const weightedPos = qTotalImpressions > 0
    ? Object.values(queryMap).reduce((s, v) => s + v.posWt, 0) / qTotalImpressions
    : null;
  const pageMap = {};
  snaps.forEach(x => (x.topPages || []).forEach(p => {
    if (!pageMap[p.page]) pageMap[p.page] = { clicks: 0, impressions: 0, posWt: 0 };
    pageMap[p.page].clicks      += p.clicks || 0;
    pageMap[p.page].impressions += p.impressions || 0;
    pageMap[p.page].posWt       += (p.position || 0) * (p.impressions || 0);
  }));
  const topPages = Object.entries(pageMap)
    .sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 10)
    .map(([page, v]) => ({
      page, clicks: v.clicks, impressions: v.impressions,
      ctr:      v.impressions > 0 ? Math.round(v.clicks / v.impressions * 10000) / 10000 : 0,
      position: v.impressions > 0 ? Math.round(v.posWt / v.impressions * 10) / 10 : null,
    }));
  return {
    date: snaps.length + ' days',
    summary: { clicks: totalClicks, impressions: totalImpressions,
      ctr: totalImpressions > 0 ? Math.round(totalClicks / totalImpressions * 10000) / 10000 : 0,
      position: weightedPos != null ? Math.round(weightedPos * 10) / 10 : null },
    topQueries, topPages,
  };
}

function aggregateGA4(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const totalSessions    = snaps.reduce((s, x) => s + (x.sessions || 0), 0);
  const totalUsers       = snaps.reduce((s, x) => s + (x.users || 0), 0);
  const totalNewUsers    = snaps.reduce((s, x) => s + (x.newUsers || 0), 0);
  const totalConversions = snaps.reduce((s, x) => s + (x.conversions || 0), 0);
  const totalRevenue     = snaps.reduce((s, x) => s + (x.revenue || 0), 0);
  const active = snaps.filter(x => x.sessions > 0);
  const activeSess = active.reduce((s, x) => s + x.sessions, 0);
  const bounceRate        = activeSess > 0 ? active.reduce((s, x) => s + x.bounceRate * x.sessions, 0) / activeSess : null;
  const avgSessionDuration = activeSess > 0 ? active.reduce((s, x) => s + x.avgSessionDuration * x.sessions, 0) / activeSess : null;
  const sourceMap = {};
  snaps.forEach(x => (x.topSources || []).forEach(s => {
    const k = s.source + '/' + s.medium;
    if (!sourceMap[k]) sourceMap[k] = { source: s.source, medium: s.medium, sessions: 0, conversions: 0, revenue: 0 };
    sourceMap[k].sessions    += s.sessions || 0;
    sourceMap[k].conversions += s.conversions || 0;
    sourceMap[k].revenue     += s.revenue || 0;
  }));
  const topSources = Object.values(sourceMap).sort((a, b) => b.sessions - a.sessions).slice(0, 5);
  const pageMap = {};
  snaps.forEach(x => (x.topLandingPages || []).forEach(p => {
    if (!pageMap[p.page]) pageMap[p.page] = { page: p.page, sessions: 0, conversions: 0, revenue: 0 };
    pageMap[p.page].sessions    += p.sessions || 0;
    pageMap[p.page].conversions += p.conversions || 0;
    pageMap[p.page].revenue     += p.revenue || 0;
  }));
  const topLandingPages = Object.values(pageMap).sort((a, b) => b.sessions - a.sessions).slice(0, 5);
  return {
    date: snaps.length + ' days',
    sessions: totalSessions, users: totalUsers, newUsers: totalNewUsers,
    bounceRate: bounceRate != null ? Math.round(bounceRate * 1000) / 1000 : null,
    avgSessionDuration: avgSessionDuration != null ? Math.round(avgSessionDuration) : null,
    conversions: totalConversions,
    conversionRate: totalSessions > 0 ? Math.round(totalConversions / totalSessions * 1000) / 1000 : 0,
    revenue: Math.round(totalRevenue * 100) / 100,
    topSources, topLandingPages,
  };
}
```

- [ ] **Step 3: Extend the filter selection block in `renderCROTab`**

Find the existing `let cl, sh, pcl, psh, dateLabel` block and extend it to also select `ga4`, `gsc`, `pga4`, `pgsc`:

```js
  const gscAll = cro.gscAll || [];
  const ga4All = cro.ga4All || [];

  let cl, sh, ga4, gsc, pcl, psh, pga4, pgsc, dateLabel;
  if (croFilter === 'yesterday') {
    cl = clarityAll[1] || null; pcl = clarityAll[2] || null;
    sh = shopifyAll[1] || null; psh = shopifyAll[2] || null;
    ga4 = ga4All[1] || null;   pga4 = ga4All[2] || null;
    gsc = gscAll[1] || null;   pgsc = gscAll[2] || null;
    dateLabel = 'Yesterday';
  } else if (croFilter === '7days') {
    cl  = aggregateClarity(clarityAll.slice(0,7));   pcl  = aggregateClarity(clarityAll.slice(7,14));
    sh  = aggregateShopify(shopifyAll.slice(0,7));   psh  = aggregateShopify(shopifyAll.slice(7,14));
    ga4 = aggregateGA4(ga4All.slice(0,7));           pga4 = aggregateGA4(ga4All.slice(7,14));
    gsc = aggregateGSC(gscAll.slice(0,7));           pgsc = aggregateGSC(gscAll.slice(7,14));
    dateLabel = 'Last 7 Days';
  } else if (croFilter === '30days') {
    cl  = aggregateClarity(clarityAll.slice(0,30));  pcl  = aggregateClarity(clarityAll.slice(30,60));
    sh  = aggregateShopify(shopifyAll.slice(0,30));  psh  = aggregateShopify(shopifyAll.slice(30,60));
    ga4 = aggregateGA4(ga4All.slice(0,30));          pga4 = aggregateGA4(ga4All.slice(30,60));
    gsc = aggregateGSC(gscAll.slice(0,30));          pgsc = aggregateGSC(gscAll.slice(30,60));
    dateLabel = 'Last 30 Days';
  } else {
    cl = clarityAll[0] || null; pcl = clarityAll[1] || null;
    sh = shopifyAll[0] || null; psh = shopifyAll[1] || null;
    ga4 = ga4All[0] || null;   pga4 = ga4All[1] || null;
    gsc = gscAll[0] || null;   pgsc = gscAll[1] || null;
    dateLabel = 'Today';
  }
```

- [ ] **Step 4: Verify server starts and `/api/data` includes new fields**

```bash
node agents/dashboard/index.js &
sleep 2
curl -s http://localhost:3050/api/data | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('gscAll:', d.cro.gscAll?.length, 'ga4All:', d.cro.ga4All?.length)"
kill %1
```
Expected: `gscAll: 1 ga4All: 1` (or however many snapshots exist)

- [ ] **Step 5: Verify client script still parses cleanly**

```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('agents/dashboard/index.js', 'utf8');
const s = src.indexOf('<script>', src.indexOf('const HTML = \`'));
const e = src.indexOf('</script>', s);
try { new Function(src.slice(s+8, e)); console.log('OK'); } catch(err) { console.log('ERROR:', err.message); }
"
```
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: extend dashboard parseCROData and add aggregateGSC/aggregateGA4 helpers"
```

---

## Task 8: Dashboard — SEO tab GSC panel

**Files:**
- Modify: `agents/dashboard/index.js`

Add a GSC panel to the SEO tab. The SEO tab currently has: Content Pipeline card, Keyword Rankings card, Posts card. The GSC panel is added after Posts.

**CRITICAL:** Client-side JS inside the HTML template literal — no backticks, no unescaped `\n`.

- [ ] **Step 1: Add CSS for the GSC panel**

Add to the `<style>` block (before `</style>`):
```css
  .gsc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .gsc-table th { text-align: left; font-size: 11px; color: var(--muted); font-weight: 500; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .gsc-table td { padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .gsc-table td:not(:first-child) { text-align: right; }
  .gsc-summary { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
  .gsc-stat { display: flex; flex-direction: column; }
  .gsc-stat-value { font-size: 20px; font-weight: 700; color: var(--text); }
  .gsc-stat-label { font-size: 11px; color: var(--muted); margin-top: 2px; }
```

- [ ] **Step 2: Add GSC panel HTML placeholder to SEO tab**

Find the closing `</div><!-- /tab-seo -->` and add a placeholder card before it:
```html
  <div class="card" id="gsc-seo-card" style="margin-top:0">
    <div class="card-header"><h2>Search Console</h2><span class="section-note" id="gsc-seo-note"></span></div>
    <div class="card-body" id="gsc-seo-body"><p class="empty-state">Loading…</p></div>
  </div>
```

- [ ] **Step 3: Add `renderGSCSEOPanel(data)` function to client script**

Add before `renderCROTab`:
```js
function renderGSCSEOPanel(data) {
  const gscAll = data.cro?.gscAll || [];
  const gsc  = gscAll[0] || null;
  const pgsc = gscAll[1] || null;

  const fmtPos = v => v != null ? v.toFixed(1) : '—';
  const fmtPct = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const deltaStr = (curr, prev, higherBetter) => {
    if (curr == null || prev == null) return '';
    const d = curr - prev;
    if (Math.abs(d) < 0.001) return '';
    const up = d > 0;
    const good = higherBetter ? up : !up;
    const color = good ? 'var(--green)' : 'var(--red)';
    const sign = up ? '+' : '';
    return ' <span style="font-size:10px;color:' + color + '">' + sign + (Math.abs(d) < 1 ? d.toFixed(2) : Math.round(d)) + '</span>';
  };

  const noteEl = document.getElementById('gsc-seo-note');
  const bodyEl = document.getElementById('gsc-seo-body');
  if (noteEl) noteEl.textContent = gsc ? esc(gsc.date) : '';

  if (!gsc) {
    bodyEl.innerHTML = '<p class="empty-state">No GSC data yet — run gsc-collector to get started.</p>';
    return;
  }

  const s = gsc.summary;
  const ps = pgsc?.summary;

  let html = '<div class="gsc-summary">' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtNum(s.clicks) + deltaStr(s.clicks, ps?.clicks, true) + '</span><span class="gsc-stat-label">Clicks</span></div>' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtNum(s.impressions) + deltaStr(s.impressions, ps?.impressions, true) + '</span><span class="gsc-stat-label">Impressions</span></div>' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtPct(s.ctr) + deltaStr(s.ctr, ps?.ctr, true) + '</span><span class="gsc-stat-label">CTR</span></div>' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtPos(s.position) + deltaStr(s.position != null ? -s.position : null, ps?.position != null ? -ps.position : null, true) + '</span><span class="gsc-stat-label">Avg Position</span></div>' +
    '</div>';

  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">';

  // Top queries table
  html += '<div><div style="font-size:11px;font-weight:600;margin-bottom:8px">Top Queries</div>' +
    '<table class="gsc-table"><thead><tr><th>Query</th><th>Clicks</th><th>Impr</th><th>CTR</th><th>Pos</th></tr></thead><tbody>' +
    (gsc.topQueries || []).map(q =>
      '<tr><td>' + esc(q.query.length > 40 ? q.query.slice(0,40) + '…' : q.query) + '</td>' +
      '<td>' + q.clicks + '</td><td>' + q.impressions + '</td>' +
      '<td>' + fmtPct(q.ctr) + '</td><td>' + fmtPos(q.position) + '</td></tr>'
    ).join('') +
    '</tbody></table></div>';

  // Top pages table
  html += '<div><div style="font-size:11px;font-weight:600;margin-bottom:8px">Top Pages</div>' +
    '<table class="gsc-table"><thead><tr><th>Page</th><th>Clicks</th><th>Impr</th><th>CTR</th><th>Pos</th></tr></thead><tbody>' +
    (gsc.topPages || []).map(p => {
      const slug = p.page.replace(/^https?:\/\/[^/]+/, '').slice(0, 35) || '/';
      return '<tr><td title="' + esc(p.page) + '">' + esc(slug.length < p.page.replace(/^https?:\/\/[^/]+/, '').length ? slug + '…' : slug) + '</td>' +
        '<td>' + p.clicks + '</td><td>' + p.impressions + '</td>' +
        '<td>' + fmtPct(p.ctr) + '</td><td>' + fmtPos(p.position) + '</td></tr>';
    }).join('') +
    '</tbody></table></div>';

  html += '</div>';
  bodyEl.innerHTML = html;
}
```

- [ ] **Step 4: Call `renderGSCSEOPanel` from `loadData`**

In the `loadData` function, add after `renderPosts(data)`:
```js
    renderGSCSEOPanel(data);
```

- [ ] **Step 5: Verify client script still parses cleanly**

```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('agents/dashboard/index.js', 'utf8');
const s = src.indexOf('<script>', src.indexOf('const HTML = \`'));
const e = src.indexOf('</script>', s);
try { new Function(src.slice(s+8, e)); console.log('OK'); } catch(err) { console.log('ERROR:', err.message); }
"
```
Expected: `OK`

- [ ] **Step 6: Visual verification**

Start the dashboard and verify the GSC panel appears at the bottom of the SEO tab with real data.

```bash
node agents/dashboard/index.js --open
```

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add GSC panel to SEO tab in dashboard"
```

---

## Task 9: Dashboard — CRO tab 2×2 grid + KPI strip

**Files:**
- Modify: `agents/dashboard/index.js`

Two changes: (1) expand cards grid CSS from 2-column to 2×2 and add GA4 + GSC card placeholder divs; (2) update KPI strip to use GA4 conversion rate and bounce rate.

**CRITICAL:** No backticks or `\n` inside the template literal.

- [ ] **Step 1: Update the CRO grid CSS**

Find:
```css
  .cro-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
```
Change to:
```css
  .cro-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .cro-grid-2x2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
```
(Or update the existing `.cro-grid` — check the current class name in the file and update accordingly.)

- [ ] **Step 2: Add GA4 and GSC card placeholder divs to CRO tab HTML**

Find the existing CRO tab grid:
```html
  <div class="cro-grid" style="margin-bottom:16px">
    <div id="cro-clarity-card"></div>
    <div id="cro-shopify-card"></div>
  </div>
```

Change to:
```html
  <div class="cro-grid" style="margin-bottom:16px">
    <div id="cro-clarity-card"></div>
    <div id="cro-shopify-card"></div>
    <div id="cro-ga4-card"></div>
    <div id="cro-gsc-card"></div>
  </div>
```

- [ ] **Step 3: Update KPI strip in `renderCROTab` to use GA4 metrics**

Find the `kpis` array definition and replace Conversion Rate (currently cross-source) with GA4 conversion rate, and add Bounce Rate:

```js
  const kpis = [
    { label: 'Conversion Rate', value: ga4 ? fmtPct(ga4.conversionRate * 100) : '—',
      d: delta(ga4?.conversionRate != null ? ga4.conversionRate * 100 : null,
               pga4?.conversionRate != null ? pga4.conversionRate * 100 : null), alert: false },
    { label: 'Bounce Rate',     value: ga4 ? fmtPct(ga4.bounceRate * 100) : '—',
      d: delta(ga4?.bounceRate != null ? ga4.bounceRate * 100 : null,
               pga4?.bounceRate != null ? pga4.bounceRate * 100 : null, false), alert: false },
    { label: 'Avg Order Value', value: sh ? fmtDollar(sh.orders.aov) : '—',
      d: delta(sh?.orders?.aov, psh?.orders?.aov), alert: false },
    { label: 'Real Sessions',   value: cl ? cl.sessions.real : '—',
      sub: cl ? 'of ' + cl.sessions.total + ' total' : '',
      d: delta(cl?.sessions?.real, pcl?.sessions?.real), alert: false },
    { label: 'Script Errors',   value: cl ? fmtPct(cl.behavior.scriptErrorPct) : '—',
      d: delta(cl?.behavior?.scriptErrorPct, pcl?.behavior?.scriptErrorPct, false),
      alert: cl?.behavior?.scriptErrorPct > 5 },
    { label: 'Scroll Depth',    value: cl ? fmtPct(cl.behavior.scrollDepth) : '—',
      d: delta(cl?.behavior?.scrollDepth, pcl?.behavior?.scrollDepth), alert: false },
    { label: 'Cart Abandon',    value: sh ? fmtPct(sh.cartAbandonmentRate * 100) : '—',
      d: delta(sh?.cartAbandonmentRate != null ? sh.cartAbandonmentRate * 100 : null,
               psh?.cartAbandonmentRate != null ? psh.cartAbandonmentRate * 100 : null, false), alert: false },
  ];
```

- [ ] **Step 4: Add GA4 card rendering to `renderCROTab`**

After the Shopify card rendering block, add:

```js
  // ── GA4 card ────────────────────────────────────────────────────────────────
  const ga4Html = ga4 ? (
    '<div class="card">' +
    '<div class="card-header"><h2>GA4</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Sessions</td><td>' + fmtNum(ga4.sessions) + '</td></tr>' +
    '<tr><td>Users</td><td>' + fmtNum(ga4.users) + ' <span class="cro-sub">(' + fmtNum(ga4.newUsers) + ' new)</span></td></tr>' +
    '<tr><td>Bounce Rate</td><td>' + fmtPct(ga4.bounceRate * 100) + '</td></tr>' +
    '<tr><td>Avg Session</td><td>' + (ga4.avgSessionDuration != null ? Math.round(ga4.avgSessionDuration) + 's' : '—') + '</td></tr>' +
    '<tr><td>Conversions</td><td>' + fmtNum(ga4.conversions) + ' <span class="cro-sub">(' + fmtPct(ga4.conversionRate * 100) + ')</span></td></tr>' +
    '<tr><td>Revenue</td><td>' + fmtDollar(ga4.revenue) + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Sources</div>' +
    (ga4.topSources || []).map((s, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + (i+1) + '. ' + esc(s.source) + ' / ' + esc(s.medium) + ' — ' + fmtNum(s.sessions) + ' sessions</div>'
    ).join('') +
    '<div style="margin-top:10px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Landing Pages</div>' +
    (ga4.topLandingPages || []).map((p, i) => {
      const slug = (p.page || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 40) || '/';
      return '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + (i+1) + '. ' + esc(slug) + ' — ' + fmtDollar(p.revenue) + '</div>';
    }).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No GA4 data yet — run ga4-collector to get started.</p></div></div>';

  document.getElementById('cro-ga4-card').innerHTML = ga4Html;
```

- [ ] **Step 5: Add GSC card rendering to `renderCROTab`**

After the GA4 card block:

```js
  // ── GSC card (CRO tab) ──────────────────────────────────────────────────────
  const gscCROHtml = gsc ? (
    '<div class="card">' +
    '<div class="card-header"><h2>Search Console</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Clicks</td><td>' + fmtNum(gsc.summary?.clicks) + '</td></tr>' +
    '<tr><td>Impressions</td><td>' + fmtNum(gsc.summary?.impressions) + '</td></tr>' +
    '<tr><td>CTR</td><td>' + (gsc.summary?.ctr != null ? (gsc.summary.ctr * 100).toFixed(1) + '%' : '—') + '</td></tr>' +
    '<tr><td>Avg Position</td><td>' + (gsc.summary?.position != null ? gsc.summary.position.toFixed(1) : '—') + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Queries</div>' +
    (gsc.topQueries || []).slice(0, 5).map((q, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + (i+1) + '. ' + esc(q.query.length > 40 ? q.query.slice(0,40) + '…' : q.query) + ' — ' + q.clicks + ' clicks</div>'
    ).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No GSC data yet — run gsc-collector to get started.</p></div></div>';

  document.getElementById('cro-gsc-card').innerHTML = gscCROHtml;
```

- [ ] **Step 6: Verify client script parses cleanly**

```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('agents/dashboard/index.js', 'utf8');
const s = src.indexOf('<script>', src.indexOf('const HTML = \`'));
const e = src.indexOf('</script>', s);
try { new Function(src.slice(s+8, e)); console.log('OK'); } catch(err) { console.log('ERROR:', err.message); }
"
```
Expected: `OK`

- [ ] **Step 7: Visual verification**

```bash
node agents/dashboard/index.js --open
```

Check:
1. CRO tab KPI strip shows Conversion Rate (from GA4) and Bounce Rate as the first two cards
2. CRO tab cards grid shows 2×2: Clarity, Shopify, GA4, GSC
3. Empty states show when no snapshots exist for GA4/GSC
4. SEO tab shows GSC panel at the bottom

- [ ] **Step 8: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: CRO tab 2x2 grid with GA4+GSC cards, updated KPI strip with GA4 metrics"
```

---

## Task 10: Update `scripts/setup-cron.sh`

**Files:**
- Modify: `scripts/setup-cron.sh`

Add two new cron entries and update the echo summary. Times are in UTC: `15 13 * * *` (≈ 06:15 PDT / 05:15 PST) and `20 13 * * *` for GA4.

- [ ] **Step 1: Add the two new cron variables**

After the `DAILY_SHOPIFY` line:
```bash
DAILY_GSC="15 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/gsc-collector/index.js >> data/reports/scheduler/gsc-collector.log 2>&1"
DAILY_GA4="20 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/ga4-collector/index.js >> data/reports/scheduler/ga4-collector.log 2>&1"
```

- [ ] **Step 2: Add the variables to the `NEW_CRONTAB` block**

Add `$DAILY_GSC` and `$DAILY_GA4` after `$DAILY_SHOPIFY` in the heredoc.

- [ ] **Step 3: Update the echo summary lines**

Add:
```bash
echo "  Daily   06:15 UTC — gsc-collector"
echo "  Daily   06:20 UTC — ga4-collector"
```

- [ ] **Step 4: Test the script locally**

```bash
bash scripts/setup-cron.sh
crontab -l | grep -E "gsc|ga4"
```
Expected: two new lines matching the cron expressions for gsc-collector and ga4-collector.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-cron.sh
git commit -m "feat: add gsc-collector and ga4-collector cron entries to setup-cron.sh"
```

---

## Deployment

After all tasks are committed and pushed:

```bash
git push
```

On the server:
```bash
cd /root/seo-claude && git pull && pm2 restart seo-dashboard
# Re-run setup-cron.sh to install the new cron jobs:
./scripts/setup-cron.sh
# Run collectors immediately to populate initial data:
node agents/gsc-collector/index.js
node agents/ga4-collector/index.js
```

Verify the dashboard shows GSC and GA4 data in both the SEO and CRO tabs.
