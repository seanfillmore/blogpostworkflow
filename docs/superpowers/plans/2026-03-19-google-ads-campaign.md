# Google Ads Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Google Ads API integration and `RSC | Lotion | Search` campaign for realskincare.com, plus wire it into the existing CRO analyzer and dashboard.

**Architecture:** A new `lib/google-ads.js` client mirrors the existing `lib/ga4.js` / `lib/gsc.js` pattern (OAuth2 + developer token, daily snapshot saved to `data/snapshots/google-ads/`). A one-shot setup script creates the full campaign structure via the Ads API. The collector runs daily via cron. The dashboard gains a third Paid Search tab and two new KPI cards.

**Tech Stack:** Node.js ESM, Google Ads REST API v18, existing OAuth2 credentials (requires re-auth with adwords scope), existing `lib/notify.js` pattern for error reporting.

**Spec:** `docs/superpowers/specs/2026-03-19-google-ads-campaign-design.md`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `scripts/reauth-google.js` | Modify | Add adwords scope, update success message |
| `lib/google-ads.js` | Create | OAuth client, reporting queries, mutate wrapper |
| `agents/google-ads-collector/index.js` | Create | Daily snapshot (defaults to yesterday) |
| `scripts/create-google-ads-campaign.js` | Create | One-shot campaign creation script |
| `agents/cro-analyzer/index.js` | Modify | Add Google Ads as fifth snapshot source |
| `agents/dashboard/index.js` | Modify | Add Paid Search tab + two KPI cards |
| `scripts/setup-cron.sh` | Modify | Add daily google-ads-collector entry |

---

## Task 1: Verify developer token and add customer ID to .env

**Files:**
- Modify: `.env`

This task cannot be automated — it requires manual confirmation in the Google Ads UI.

- [ ] **Step 1: Confirm developer token is approved**

  In a browser: Google Ads → Tools → API Center. Confirm the developer token shown there matches `GOOGLE_ADS_TOKEN` in `.env` and that its status is **Approved** (Basic Access or higher). If it shows "Pending" or "Test Account", stop — the API will reject all calls until approved.

- [ ] **Step 2: Get your customer ID**

  In Google Ads UI, the 10-digit account ID appears in the top-right corner (format: `123-456-7890`). Remove the dashes and add it to `.env`:

  ```
  GOOGLE_ADS_CUSTOMER_ID=1234567890
  ```

- [ ] **Step 3: Verify token works with a test call**

  ```bash
  node --input-type=module << 'EOF'
  import { readFileSync } from 'fs';
  const env = Object.fromEntries(
    readFileSync('.env','utf8').split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => { const i=l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; })
  );
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' })
  });
  const { access_token } = await tokRes.json();
  const res = await fetch('https://googleads.googleapis.com/v18/customers:listAccessibleCustomers', {
    headers: { Authorization: `Bearer ${access_token}`, 'developer-token': env.GOOGLE_ADS_TOKEN }
  });
  console.log('Status:', res.status);
  console.log(await res.json());
  EOF
  ```

  **Expected:** Status 200 with a `resourceNames` array containing your customer ID.

  If you see status 401 or "OAUTH_TOKEN_INVALID": the refresh token lacks the adwords scope — proceed to Task 2.
  If you see 403 "DEVELOPER_TOKEN_NOT_APPROVED": the developer token is pending — wait for Google approval before continuing.

---

## Task 2: Add adwords scope to reauth script and re-authorize

**Files:**
- Modify: `scripts/reauth-google.js`

- [ ] **Step 1: Add adwords scope to SCOPES array**

  In `scripts/reauth-google.js`, find the `SCOPES` constant and add the adwords scope:

  ```js
  const SCOPES = [
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/adwords',
  ].join(' ');
  ```

- [ ] **Step 2: Update the success message**

  Find line 120 in `scripts/reauth-google.js`:
  ```js
  // Before:
  console.log('✓ Refresh token saved to .env (grants webmasters.readonly + analytics.readonly)');
  // After:
  console.log('✓ Refresh token saved to .env (grants webmasters.readonly + analytics.readonly + adwords)');
  ```

  Also update the `res.end(...)` HTML response on the line above:
  ```js
  res.end('<h2>Success!</h2><p>GSC + GA4 + Google Ads authorized. You can close this tab.</p>');
  ```

- [ ] **Step 3: Run the reauth script**

  ```bash
  node scripts/reauth-google.js
  ```

  A browser tab will open. Sign in with the Google account that owns the Ads account. Grant all requested permissions. The script will print the success message and update `GOOGLE_REFRESH_TOKEN` in `.env`.

- [ ] **Step 4: Re-run the Task 1 verification call to confirm adwords scope is now granted**

  Expected: Status 200, `resourceNames` array visible.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/reauth-google.js
  git commit -m "feat: add adwords scope to google reauth script"
  ```

---

## Task 3: Build lib/google-ads.js

**Files:**
- Create: `lib/google-ads.js`

This is the shared API client. It follows the same pattern as `lib/ga4.js`: load `.env`, get an access token via OAuth2 refresh, make authenticated requests. The Google Ads REST API additionally requires the `developer-token` header on every request.

- [ ] **Step 1: Write the failing test**

  Create `tests/lib/google-ads.test.js`:

  ```js
  import { strict as assert } from 'assert';
  import { buildHeaders, parseCustomerId, yesterdayPT } from '../../lib/google-ads.js';

  // buildHeaders returns required headers
  const headers = buildHeaders('fake-access-token', 'fake-dev-token');
  assert.equal(headers['Authorization'], 'Bearer fake-access-token');
  assert.equal(headers['developer-token'], 'fake-dev-token');
  assert.equal(headers['Content-Type'], 'application/json');

  // parseCustomerId strips dashes
  assert.equal(parseCustomerId('123-456-7890'), '1234567890');
  assert.equal(parseCustomerId('1234567890'), '1234567890');

  // yesterdayPT returns YYYY-MM-DD format
  const y = yesterdayPT();
  assert.match(y, /^\d{4}-\d{2}-\d{2}$/);

  console.log('✓ google-ads lib unit tests pass');
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  node tests/lib/google-ads.test.js
  ```

  Expected: Error — `lib/google-ads.js` does not exist yet.

- [ ] **Step 3: Create lib/google-ads.js**

  ```js
  /**
   * Shared Google Ads API v18 client
   *
   * Required .env keys:
   *   GOOGLE_CLIENT_ID
   *   GOOGLE_CLIENT_SECRET
   *   GOOGLE_REFRESH_TOKEN   (must include adwords scope — run scripts/reauth-google.js)
   *   GOOGLE_ADS_TOKEN       (developer token from Google Ads API Center)
   *   GOOGLE_ADS_CUSTOMER_ID (10-digit account ID, no dashes)
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

  export const CUSTOMER_ID = parseCustomerId(env.GOOGLE_ADS_CUSTOMER_ID || '');
  const DEV_TOKEN     = env.GOOGLE_ADS_TOKEN     || '';
  const CLIENT_ID     = env.GOOGLE_CLIENT_ID     || '';
  const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
  const REFRESH_TOKEN = env.GOOGLE_REFRESH_TOKEN || '';

  // Credential guard is deferred to getAccessToken() so pure utility functions
  // (parseCustomerId, buildHeaders, yesterdayPT) can be imported in unit tests
  // without credentials present.

  export function parseCustomerId(id) {
    return String(id || '').replace(/-/g, '');
  }

  export function buildHeaders(accessToken, devToken) {
    return {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': devToken,
      'Content-Type': 'application/json',
    };
  }

  export function yesterdayPT() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  }

  // ── token management ──────────────────────────────────────────────────────────

  let cachedToken = null;
  let tokenExpiry = 0;

  export async function getAccessToken() {
    if (!CUSTOMER_ID || !DEV_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
      throw new Error('Missing Google Ads credentials. Required: GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
    }
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
      throw new Error(`Google Ads token refresh failed: HTTP ${res.status} — ${text}`);
    }
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return cachedToken;
  }

  // ── GAQL query ────────────────────────────────────────────────────────────────

  export async function gaqlQuery(query) {
    const token = await getAccessToken();
    const url = `https://googleads.googleapis.com/v18/customers/${CUSTOMER_ID}/googleAds:searchStream`;
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token, DEV_TOKEN),
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Ads GAQL query failed: HTTP ${res.status} — ${text}`);
    }
    const batches = await res.json();
    // searchStream returns an array of result batches
    return (Array.isArray(batches) ? batches : [batches])
      .flatMap(b => b.results || []);
  }

  // ── mutate ────────────────────────────────────────────────────────────────────

  export async function mutate(operations) {
    const token = await getAccessToken();
    const url = `https://googleads.googleapis.com/v18/customers/${CUSTOMER_ID}/googleAds:mutate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token, DEV_TOKEN),
      body: JSON.stringify({ mutateOperations: operations, partialFailure: true }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Ads mutate failed: HTTP ${res.status} — ${text}`);
    }
    const data = await res.json();
    if (data.partialFailureError) {
      console.warn('⚠ Partial failure:', JSON.stringify(data.partialFailureError));
    }
    return data;
  }

  // ── daily performance snapshot ────────────────────────────────────────────────

  export async function fetchDailySnapshot(date) {
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.average_cpc,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value,
        metrics.cost_per_conversion
      FROM campaign
      WHERE segments.date = '${date}'
      ORDER BY metrics.cost_micros DESC
    `;

    const kwQuery = `
      SELECT
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.quality_info.quality_score,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.cost_micros,
        metrics.average_cpc
      FROM keyword_view
      WHERE segments.date = '${date}'
        AND metrics.impressions > 0
      ORDER BY metrics.conversions DESC
      LIMIT 10
    `;

    const [campaignRows, kwRows] = await Promise.all([
      gaqlQuery(query),
      gaqlQuery(kwQuery),
    ]);

    // GAQL REST API returns snake_case field names (not camelCase)
    const campaigns = campaignRows.map(r => ({
      id: r.campaign?.id,
      name: r.campaign?.name,
      status: r.campaign?.status,
      impressions: Number(r.metrics?.impressions || 0),
      clicks: Number(r.metrics?.clicks || 0),
      ctr: Number(r.metrics?.ctr || 0),
      avgCpc: Number(r.metrics?.average_cpc || 0) / 1_000_000,
      spend: Number(r.metrics?.cost_micros || 0) / 1_000_000,
      conversions: Number(r.metrics?.conversions || 0),
      revenue: Number(r.metrics?.conversions_value || 0),
      costPerConversion: Number(r.metrics?.cost_per_conversion || 0) / 1_000_000,
    }));

    const topKeywords = kwRows.map(r => ({
      keyword: r.ad_group_criterion?.keyword?.text,
      matchType: r.ad_group_criterion?.keyword?.match_type,
      qualityScore: r.ad_group_criterion?.quality_info?.quality_score,
      impressions: Number(r.metrics?.impressions || 0),
      clicks: Number(r.metrics?.clicks || 0),
      conversions: Number(r.metrics?.conversions || 0),
      spend: Number(r.metrics?.cost_micros || 0) / 1_000_000,
      avgCpc: Number(r.metrics?.average_cpc || 0) / 1_000_000,
    }));

    const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
    const totalClicks = campaigns.reduce((s, c) => s + c.clicks, 0);
    const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0);
    const totalConversions = campaigns.reduce((s, c) => s + c.conversions, 0);
    const totalRevenue = campaigns.reduce((s, c) => s + c.revenue, 0);

    return {
      date,
      spend: Math.round(totalSpend * 100) / 100,
      impressions: totalImpressions,
      clicks: totalClicks,
      ctr: totalImpressions > 0 ? Math.round(totalClicks / totalImpressions * 10000) / 10000 : 0,
      avgCpc: totalClicks > 0 ? Math.round((totalSpend / totalClicks) * 100) / 100 : 0,
      conversions: totalConversions,
      conversionRate: totalClicks > 0 ? Math.round(totalConversions / totalClicks * 10000) / 10000 : 0,
      costPerConversion: totalConversions > 0 ? Math.round((totalSpend / totalConversions) * 100) / 100 : 0,
      roas: totalSpend > 0 ? Math.round(totalRevenue / totalSpend * 100) / 100 : 0,
      revenue: Math.round(totalRevenue * 100) / 100,
      campaigns,
      topKeywords,
    };
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  node tests/lib/google-ads.test.js
  ```

  Expected: `✓ google-ads lib unit tests pass`

- [ ] **Step 5: Commit**

  ```bash
  git add lib/google-ads.js tests/lib/google-ads.test.js
  git commit -m "feat: add lib/google-ads.js API client"
  ```

---

## Task 4: Build agents/google-ads-collector/index.js

**Files:**
- Create: `agents/google-ads-collector/index.js`

Mirrors `agents/ga4-collector/index.js` exactly, but defaults to **yesterday** (not today) due to Google Ads reporting lag.

- [ ] **Step 1: Write the failing test**

  Create `tests/agents/google-ads-collector.test.js`:

  ```js
  import { strict as assert } from 'assert';
  import { existsSync } from 'fs';

  // Agent file exists
  assert.ok(existsSync('agents/google-ads-collector/index.js'), 'agent file missing');

  // Usage pattern check — file should import from lib/google-ads.js
  const { readFileSync } = await import('fs');
  const src = readFileSync('agents/google-ads-collector/index.js', 'utf8');
  assert.ok(src.includes('fetchDailySnapshot'), 'must call fetchDailySnapshot');
  assert.ok(src.includes('yesterdayPT'), 'must default to yesterday');
  assert.ok(src.includes('google-ads'), 'snapshot dir must be google-ads');

  console.log('✓ google-ads-collector structure tests pass');
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  node tests/agents/google-ads-collector.test.js
  ```

  Expected: Error — file does not exist.

- [ ] **Step 3: Create agents/google-ads-collector/index.js**

  ```js
  /**
   * Google Ads Collector Agent
   *
   * Fetches yesterday's Google Ads performance data and saves a snapshot to:
   *   data/snapshots/google-ads/YYYY-MM-DD.json
   *
   * Defaults to yesterday (not today) due to Google Ads reporting lag.
   *
   * Usage:
   *   node agents/google-ads-collector/index.js
   *   node agents/google-ads-collector/index.js --date 2026-03-18
   */

  import { writeFileSync, mkdirSync } from 'fs';
  import { join, dirname } from 'path';
  import { fileURLToPath } from 'url';
  import { fetchDailySnapshot, yesterdayPT } from '../../lib/google-ads.js';
  import { notify } from '../../lib/notify.js';

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(__dirname, '..', '..');
  const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'google-ads');

  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
    ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
  const date = dateArg || yesterdayPT();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('Invalid date format. Expected YYYY-MM-DD.');
    process.exit(1);
  }

  async function main() {
    console.log('Google Ads Collector\n');
    console.log(`  Date: ${date}`);

    process.stdout.write('  Fetching snapshot... ');
    const snapshot = await fetchDailySnapshot(date);
    console.log(`done ($${snapshot.spend} spend, ${snapshot.clicks} clicks, ${snapshot.conversions} conversions)`);

    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
    console.log(`  Snapshot saved: ${outPath}`);
  }

  main()
    .then(async () => {
      await notify({ subject: 'Google Ads Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }).catch(() => {});
    })
    .catch(async err => {
      await notify({ subject: 'Google Ads Collector failed', body: err.message || String(err), status: 'error' }).catch(() => {});
      console.error('Error:', err.message);
      process.exit(1);
    });
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  node tests/agents/google-ads-collector.test.js
  ```

  Expected: `✓ google-ads-collector structure tests pass`

- [ ] **Step 5: Smoke test against the live API**

  ```bash
  node agents/google-ads-collector/index.js --date 2026-03-18
  ```

  Expected: Snapshot saved to `data/snapshots/google-ads/2026-03-18.json`. Inspect it to confirm the schema matches the spec (spend, clicks, campaigns, topKeywords).

- [ ] **Step 6: Commit**

  ```bash
  git add agents/google-ads-collector/index.js tests/agents/google-ads-collector.test.js
  git commit -m "feat: add google-ads-collector daily snapshot agent"
  ```

---

## Task 5: Build scripts/create-google-ads-campaign.js

**Files:**
- Create: `scripts/create-google-ads-campaign.js`

One-shot script. Creates the full `RSC | Lotion | Search` campaign: budget → campaign → two ad groups → two RSAs → 12 keywords → negative keywords → sitelink/callout/snippet extensions. Uses `partialFailure: true` — logs failures but continues. Safe to inspect with `--dry-run` before committing to the API.

- [ ] **Step 1: Create scripts/create-google-ads-campaign.js**

  ```js
  /**
   * Create Google Ads Campaign — RSC | Lotion | Search
   *
   * One-shot setup script. Creates the full campaign structure defined in:
   *   docs/superpowers/specs/2026-03-19-google-ads-campaign-design.md
   *
   * Usage:
   *   node scripts/create-google-ads-campaign.js --dry-run   (print operations, don't send)
   *   node scripts/create-google-ads-campaign.js             (create campaign in Google Ads)
   *
   * Resources are created in sequential mutate calls because each step depends
   * on the resource name returned by the previous step (budget → campaign →
   * ad groups → RSAs + keywords + negatives).
   */

  import { mutate, CUSTOMER_ID } from '../lib/google-ads.js';

  const DRY_RUN = process.argv.includes('--dry-run');

  // ── Ad copy ───────────────────────────────────────────────────────────────────
  const lotionHeadlines = [
    'Real Coconut Oil Body Lotion',
    'Only 6 Clean Ingredients',
    'Free of Toxins & Harsh Chemicals',
    'Deep Moisture That Lasts All Day',
    'Non-Toxic Lotion for Dry Skin',
    'Made With Organic Coconut Oil',
    'No Parabens, SLS, or Fragrance',
    'Shop Real Skin Care Lotion',
    'Lightweight & Fast Absorbing',
    'Clean Beauty. Real Ingredients.',
    'Feel the Difference in One Use',
    '100% Natural Body Lotion',
    'Try Our Coconut Breeze Formula',
    'Ships Fast — Order Today',
    'Clean Lotion Your Skin Will Love',
  ].map(text => ({ text }));

  const lotionDescriptions = [
    { text: 'Moisturize without the mystery ingredients. Our coconut oil body lotion is made with only 6 real, clean ingredients you can actually pronounce. No fillers, no fragrance.' },
    { text: 'Ditch the toxins. Real Skin Care body lotion is non-toxic, fragrance-free, and made with organic coconut oil — gentle enough for sensitive skin, effective enough for extremely dry skin.' },
    { text: 'Real people. Real results. Our coconut lotion absorbs fast, locks in moisture, and skips the harmful chemicals found in most drugstore brands. Clean beauty that works.' },
    { text: 'Not sure what\'s in your lotion? Ours has 6 ingredients and nothing to hide. Organic coconut oil base, zero parabens, zero SLS. Try Real Skin Care today.' },
  ];

  const naturalHeadlines = [
    'Natural Body Lotion That Works',
    'Only 6 Clean Ingredients Total',
    'Organic Coconut Oil Formula',
    'No Parabens. No SLS. No Toxins.',
    'Best Non-Toxic Body Lotion',
    'Clean Body Lotion for Dry Skin',
    'Skip the Harsh Chemicals',
    'Real Ingredients. Real Results.',
    'Fragrance-Free & Gentle Formula',
    'Natural Lotion for Sensitive Skin',
    'Lightweight & Deeply Moisturizing',
    'Shop Real Skin Care',
    'Made for Dry & Sensitive Skin',
    'Cruelty-Free. Vegan. Clean.',
    'Your Skin Knows the Difference',
  ].map(text => ({ text }));

  const naturalDescriptions = [
    { text: 'Tired of body lotions packed with chemicals you can\'t pronounce? Real Skin Care is made with just 6 ingredients — organic coconut oil, shea butter, and nothing you wouldn\'t recognize.' },
    { text: 'Non-toxic, fragrance-free, and actually moisturizing. Our natural body lotion is formulated for dry and sensitive skin — no parabens, no SLS, no artificial fragrance. Clean skincare, simplified.' },
    { text: 'Most body lotions have 20+ ingredients. Ours has 6. Real Skin Care natural lotion is lightweight, fast-absorbing, and free of the toxins your skin doesn\'t need. Clean beauty made simple.' },
    { text: 'Your lotion should heal, not harm. Real Skin Care uses organic coconut oil as the base for a clean, effective body lotion — gentle on skin, tough on dry patches. Free of harsh chemicals.' },
  ];

  const LOTION_URL = 'https://www.realskincare.com/products/coconut-lotion?utm_source=google&utm_medium=cpc&utm_campaign=rsc-lotion-search';

  // ── Keywords ──────────────────────────────────────────────────────────────────
  const lotionKeywords = [
    { text: 'coconut lotion',             matchType: 'EXACT' },
    { text: 'coconut body lotion',        matchType: 'EXACT' },
    { text: 'coconut lotion for dry skin', matchType: 'PHRASE' },
    { text: 'coconut oil lotion',         matchType: 'PHRASE' },
    { text: 'buy coconut lotion',         matchType: 'EXACT' },
    { text: 'coconut lotion natural',     matchType: 'EXACT' },
  ];

  const naturalKeywords = [
    { text: 'natural body lotion',          matchType: 'EXACT' },
    { text: 'clean body lotion',            matchType: 'EXACT' },
    { text: 'non toxic body lotion',        matchType: 'EXACT' },
    { text: 'natural lotion for dry skin',  matchType: 'PHRASE' },
    { text: 'fragrance free body lotion',   matchType: 'PHRASE' },
    { text: 'organic body lotion',          matchType: 'EXACT' },
  ];

  const negativeTerms = ['DIY', 'recipe', 'homemade', 'wholesale', 'bulk', 'free sample', 'cheap', 'dollar', 'sunscreen', 'face', 'baby', 'dog', 'cat', 'amazon', 'walmart', 'target'];

  // ── Extensions ────────────────────────────────────────────────────────────────
  const BASE_UTM = 'utm_source=google&utm_medium=cpc&utm_campaign=rsc-lotion-search';
  const DOMAIN = 'https://www.realskincare.com';
  const sitelinks = [
    { text: 'Shop Coconut Lotion',    url: `${DOMAIN}/products/coconut-lotion?${BASE_UTM}&utm_content=sitelink-coconut-lotion` },
    { text: 'Natural Deodorant',      url: `${DOMAIN}/products/coconut-oil-deodorant?${BASE_UTM}&utm_content=sitelink-deodorant` },
    { text: 'Coconut Oil Toothpaste', url: `${DOMAIN}/products/coconut-oil-toothpaste?${BASE_UTM}&utm_content=sitelink-toothpaste` },
    { text: 'All Products',           url: `${DOMAIN}/collections/all?${BASE_UTM}&utm_content=sitelink-all` },
  ];
  const calloutTexts = ['6-Ingredient Formula', 'Fragrance Free', 'Vegan & Cruelty-Free', 'Ships Fast'];
  const snippetValues = ['Organic Coconut Oil', 'Shea Butter', 'Vitamin E'];

  // ── Main — sequential mutate calls ───────────────────────────────────────────
  // Each step depends on resource names returned by the previous step.
  async function main() {
    console.log('Create Google Ads Campaign — RSC | Lotion | Search\n');
    console.log(`Customer ID: ${CUSTOMER_ID}`);

    if (DRY_RUN) {
      console.log('\nDRY RUN — no API calls will be made');
      console.log('Sequential mutate calls that will be sent:');
      console.log('  Step 1: campaignBudgetOperation — RSC Lotion Budget ($10/day, explicitlyShared=false)');
      console.log('  Step 2: campaignOperation — RSC | Lotion | Search (PAUSED, manualCpc)');
      console.log('  Step 3: adGroupOperation x2 — Coconut Lotion, Natural Body Lotion');
      console.log('  Step 4: adGroupAdOperation x2 — RSA per ad group');
      console.log('  Step 5: adGroupCriterionOperation x12 — keywords');
      console.log('  Step 6: campaignCriterionOperation x16 — negative keywords');
      console.log('  Step 7: campaignCriterionOperation x2 — US geo target + mobile +30% bid adj');
      console.log('  Step 8: assetOperation x9 — 4 sitelinks + 4 callouts + 1 structured snippet');
      console.log('  Step 8b: campaignAssetOperation x9 — link assets to campaign');
      console.log('\nDry run complete. Run without --dry-run to create.');
      return;
    }

    // Step 1: Create budget
    process.stdout.write('\nStep 1: Creating campaign budget... ');
    const budgetResult = await mutate([{
      campaignBudgetOperation: {
        create: { name: 'RSC Lotion Budget', amountMicros: '10000000', deliveryMethod: 'STANDARD', explicitlyShared: false },
      },
    }]);
    const budgetName = budgetResult.mutateOperationResponses?.[0]?.campaignBudgetResult?.resourceName;
    if (!budgetName) throw new Error('No budget resource name returned: ' + JSON.stringify(budgetResult));
    console.log(`✓  ${budgetName}`);

    // Step 2: Create campaign using real budget resource name
    process.stdout.write('Step 2: Creating campaign... ');
    const campaignResult = await mutate([{
      campaignOperation: {
        create: {
          name: 'RSC | Lotion | Search',
          advertisingChannelType: 'SEARCH',
          status: 'PAUSED',
          campaignBudget: budgetName,
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
          geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST' },
          manualCpc: { enhancedCpcEnabled: false },
        },
      },
    }]);
    const campaignName = campaignResult.mutateOperationResponses?.[0]?.campaignResult?.resourceName;
    if (!campaignName) throw new Error('No campaign resource name returned: ' + JSON.stringify(campaignResult));
    console.log(`✓  ${campaignName}`);

    // Step 3: Create ad groups using real campaign resource name
    process.stdout.write('Step 3: Creating ad groups... ');
    const agResult = await mutate([
      { adGroupOperation: { create: { name: 'Coconut Lotion', campaign: campaignName, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: '800000' } } },
      { adGroupOperation: { create: { name: 'Natural Body Lotion', campaign: campaignName, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: '800000' } } },
    ]);
    const agResponses = agResult.mutateOperationResponses || [];
    const lotionAgName = agResponses[0]?.adGroupResult?.resourceName;
    const naturalAgName = agResponses[1]?.adGroupResult?.resourceName;
    if (!lotionAgName || !naturalAgName) throw new Error('No ad group resource names returned: ' + JSON.stringify(agResult));
    console.log(`✓  ${lotionAgName}, ${naturalAgName}`);

    // Step 4: Create RSAs using real ad group resource names
    process.stdout.write('Step 4: Creating responsive search ads... ');
    await mutate([
      { adGroupAdOperation: { create: { adGroup: lotionAgName, status: 'ENABLED', ad: { responsiveSearchAd: { headlines: lotionHeadlines, descriptions: lotionDescriptions }, finalUrls: [LOTION_URL] } } } },
      { adGroupAdOperation: { create: { adGroup: naturalAgName, status: 'ENABLED', ad: { responsiveSearchAd: { headlines: naturalHeadlines, descriptions: naturalDescriptions }, finalUrls: [LOTION_URL] } } } },
    ]);
    console.log('✓');

    // Step 5: Create keywords using real ad group resource names
    process.stdout.write('Step 5: Creating keywords... ');
    await mutate([
      ...lotionKeywords.map(kw => ({ adGroupCriterionOperation: { create: { adGroup: lotionAgName, status: 'ENABLED', keyword: { text: kw.text, matchType: kw.matchType }, cpcBidMicros: '800000' } } })),
      ...naturalKeywords.map(kw => ({ adGroupCriterionOperation: { create: { adGroup: naturalAgName, status: 'ENABLED', keyword: { text: kw.text, matchType: kw.matchType }, cpcBidMicros: '800000' } } })),
    ]);
    console.log('✓');

    // Step 6: Create negative keywords using real campaign resource name
    process.stdout.write('Step 6: Creating negative keywords... ');
    await mutate(negativeTerms.map(text => ({
      campaignCriterionOperation: { create: { campaign: campaignName, negative: true, keyword: { text, matchType: 'BROAD' } } },
    })));
    console.log('✓');

    // Step 7: US-only geo targeting + mobile +30% bid adjustment
    process.stdout.write('Step 7: Setting geo targeting and device bid adjustment... ');
    await mutate([
      { campaignCriterionOperation: { create: { campaign: campaignName, location: { geoTargetConstant: 'geoTargetConstants/2840' } } } }, // United States
      { campaignCriterionOperation: { create: { campaign: campaignName, device: { type: 'MOBILE' }, bidModifier: 1.3 } } }, // +30%
    ]);
    console.log('✓');

    // Step 8: Ad extensions — sitelinks, callouts, structured snippet
    // Google Ads API v18 uses Assets: create asset first, then link to campaign.
    process.stdout.write('Step 8: Creating ad extension assets... ');
    const assetOps = [
      ...sitelinks.map(sl => ({ assetOperation: { create: { sitelinkAsset: { linkText: sl.text, finalUrls: [sl.url] } } } })),
      ...calloutTexts.map(text => ({ assetOperation: { create: { calloutAsset: { calloutText: text } } } })),
      { assetOperation: { create: { structuredSnippetAsset: { header: 'Ingredients', values: snippetValues } } } },
    ];
    const assetResult = await mutate(assetOps);
    const assetNames = (assetResult.mutateOperationResponses || []).map(r => r.assetResult?.resourceName).filter(Boolean);
    console.log(`✓ (${assetNames.length} assets)`);

    process.stdout.write('Step 8b: Linking assets to campaign... ');
    const fieldTypes = [
      ...sitelinks.map(() => 'SITELINK'),
      ...calloutTexts.map(() => 'CALLOUT'),
      'STRUCTURED_SNIPPET',
    ];
    await mutate(assetNames.map((name, i) => ({
      campaignAssetOperation: { create: { campaign: campaignName, asset: name, fieldType: fieldTypes[i] } },
    })));
    console.log('✓');

    console.log('\n✓ Campaign created. Campaign is PAUSED — review in Google Ads UI before enabling.');
    console.log(`  Campaign: ${campaignName}`);
  }

  main().catch(err => { console.error(err.message); process.exit(1); });
  ```

- [ ] **Step 2: Dry-run to verify operations print correctly**

  ```bash
  node scripts/create-google-ads-campaign.js --dry-run
  ```

  Expected: Lists all 30+ operations by type, no API calls made.

- [ ] **Step 3: Create campaign (when ready)**

  ```bash
  node scripts/create-google-ads-campaign.js
  ```

  Expected: Campaign created in Google Ads UI as **PAUSED**. Open the UI and verify: campaign, 2 ad groups, 2 RSAs, 12 keywords, 16 negatives are all present before enabling.

- [ ] **Step 4: In Google Ads UI — import GA4 conversion**

  Google Ads → Tools & Settings → Conversions → New conversion action → Import → Google Analytics 4 → select `purchase`. This links Shopify purchase events to Google Ads for Smart Bidding in Phase 2.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/create-google-ads-campaign.js
  git commit -m "feat: add campaign creation script for RSC Lotion Search"
  ```

---

## Task 6: Update cro-analyzer to include Google Ads data

**Files:**
- Modify: `agents/cro-analyzer/index.js`

- [ ] **Step 1: Write the failing test**

  Create `tests/agents/cro-analyzer-ads.test.js`:

  ```js
  import { strict as assert } from 'assert';
  import { readFileSync } from 'fs';

  const src = readFileSync('agents/cro-analyzer/index.js', 'utf8');

  assert.ok(src.includes('GOOGLE_ADS_DIR'), 'must define GOOGLE_ADS_DIR');
  assert.ok(src.includes("loadRecentSnapshots(GOOGLE_ADS_DIR)"), 'must load google ads snapshots');
  assert.ok(src.includes('Google Ads Performance'), 'must include Google Ads block in prompt');
  assert.ok(src.includes('Google Ads:'), 'must mention Google Ads in system prompt');

  console.log('✓ cro-analyzer google ads integration tests pass');
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  node tests/agents/cro-analyzer-ads.test.js
  ```

  Expected: Fails — `GOOGLE_ADS_DIR` not found.

- [ ] **Step 3: Add Google Ads to cro-analyzer**

  In `agents/cro-analyzer/index.js`, make these four changes:

  **Add constant** (after `GA4_DIR` on line 23):
  ```js
  const GOOGLE_ADS_DIR = join(ROOT, 'data', 'snapshots', 'google-ads');
  ```

  **Load snapshots** (after `ga4Snaps` load in `main()`):
  ```js
  const adsSnaps = loadRecentSnapshots(GOOGLE_ADS_DIR);
  console.log(`  Google Ads snapshots: ${adsSnaps.length}`);
  ```

  **Update system prompt** — add to the data sources list:
  ```
  - Google Ads: campaign spend, clicks, CTR, average CPC, conversions, ROAS, top keywords by conversion
  ```

  **Add Google Ads block to user message** (after the GA4 block):
  ```js
  adsSnaps.length ? `### Google Ads Performance (${adsSnaps.length} days)\n${JSON.stringify(adsSnaps, null, 2)}` : '',
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  node tests/agents/cro-analyzer-ads.test.js
  ```

  Expected: `✓ cro-analyzer google ads integration tests pass`

- [ ] **Step 5: Commit**

  ```bash
  git add agents/cro-analyzer/index.js tests/agents/cro-analyzer-ads.test.js
  git commit -m "feat: add google ads snapshots to cro-analyzer"
  ```

---

## Task 7: Add Paid Search tab and KPI cards to dashboard

**Files:**
- Modify: `agents/dashboard/index.js`

This is the largest single change. Follow the existing patterns exactly: `parseCROData()` for server-side loading, `renderCROTab()` style for client-side rendering, and the `kpi-card` CSS class for KPI cards.

- [ ] **Step 1: Write the failing test**

  Create `tests/agents/dashboard-ads.test.js`:

  ```js
  import { strict as assert } from 'assert';
  import { readFileSync } from 'fs';

  const src = readFileSync('agents/dashboard/index.js', 'utf8');

  assert.ok(src.includes('GOOGLE_ADS_SNAPSHOTS_DIR'), 'must define snapshot dir constant');
  assert.ok(src.includes("switchTab('ads'"), 'must have ads tab button');
  assert.ok(src.includes('tab-ads'), 'must have tab-ads panel');
  assert.ok(src.includes('renderAdsTab'), 'must have renderAdsTab function');
  assert.ok(src.includes('Ad Spend'), 'must have Ad Spend KPI card');
  assert.ok(src.includes('ROAS'), 'must have ROAS KPI card');

  console.log('✓ dashboard ads tab tests pass');
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  node tests/agents/dashboard-ads.test.js
  ```

  Expected: Fails — tab and constants not present.

- [ ] **Step 3: Add server-side snapshot loading**

  In `agents/dashboard/index.js`, add after `GA4_SNAPSHOTS_DIR` (line 205):
  ```js
  const GOOGLE_ADS_SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'google-ads');
  ```

  In `parseCROData()`, add after the GA4 block (before `return`):
  ```js
  // Load up to 60 Google Ads snapshots
  let googleAdsAll = [];
  if (existsSync(GOOGLE_ADS_SNAPSHOTS_DIR)) {
    const files = readdirSync(GOOGLE_ADS_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 60);
    googleAdsAll = files.map(f => JSON.parse(readFileSync(join(GOOGLE_ADS_SNAPSHOTS_DIR, f), 'utf8')));
  }
  ```

  Update the `return` statement to include `googleAdsAll`:
  ```js
  return { clarityAll, shopifyAll, gscAll, ga4All, googleAdsAll, brief };
  ```

- [ ] **Step 4: Add Paid Search tab button and panel to HTML**

  Find the tab nav (line 612):
  ```html
  <!-- Before: -->
  <button class="tab-btn" onclick="switchTab('cro', this)">CRO</button>
  <!-- After: add this line -->
  <button class="tab-btn" onclick="switchTab('ads', this)">Paid Search</button>
  ```

  After the closing `</div><!-- /tab-cro -->` (line 667), add:
  ```html
  <div id="tab-ads" class="tab-panel">
    <div id="ads-kpi-strip" style="margin-bottom:16px"></div>
    <div class="cro-grid" style="margin-bottom:16px">
      <div id="ads-overview-card"></div>
      <div id="ads-keywords-card"></div>
    </div>
  </div><!-- /tab-ads -->
  ```

- [ ] **Step 5: Add renderAdsTab function**

  KPI cards for Ad Spend and ROAS belong inside the Paid Search tab's `ads-kpi-strip`, not the CRO tab. Do NOT modify `.kpi-strip` CSS or `cro-kpi-strip`.

  Add before the closing `</script>` tag:
  ```js
  function renderAdsTab(data) {
    const adsAll = data.cro?.googleAdsAll || [];
    const snap = adsAll[0];

    if (!snap) {
      document.getElementById('ads-kpi-strip').innerHTML = '';
      document.getElementById('ads-overview-card').innerHTML =
        '<div class="card"><div class="card-header"><h2>Campaign Overview</h2></div>' +
        '<div class="card-body"><p class="empty-state">No Google Ads data yet — run google-ads-collector to get started.</p></div></div>';
      document.getElementById('ads-keywords-card').innerHTML = '';
      return;
    }

    // KPI strip inside the Paid Search tab
    document.getElementById('ads-kpi-strip').innerHTML =
      '<div class="kpi-strip" style="grid-template-columns: repeat(2, 1fr)">' +
      kpiCard('Ad Spend', '$' + snap.spend.toFixed(2), 'of $10.00/day') +
      kpiCard('ROAS', snap.roas.toFixed(2) + 'x', 'paid search') +
      '</div>';

    // Campaign overview card
    const overviewRows = [
      ['Spend', '$' + snap.spend.toFixed(2)],
      ['Daily Budget', '$10.00'],
      ['Impressions', fmtNum(snap.impressions)],
      ['Clicks', fmtNum(snap.clicks)],
      ['CTR', (snap.ctr * 100).toFixed(2) + '%'],
      ['Avg CPC', '$' + snap.avgCpc.toFixed(2)],
      ['Conversions', snap.conversions],
      ['CVR', (snap.conversionRate * 100).toFixed(2) + '%'],
      ['Revenue', '$' + snap.revenue.toFixed(2)],
      ['ROAS', snap.roas.toFixed(2) + 'x'],
      ['Cost/Conv', snap.costPerConversion > 0 ? '$' + snap.costPerConversion.toFixed(2) : '—'],
    ];

    document.getElementById('ads-overview-card').innerHTML =
      '<div class="card"><div class="card-header"><h2>Campaign Overview</h2>' +
      '<span class="section-note">' + esc(snap.date) + '</span></div>' +
      '<div class="card-body"><table class="cro-table">' +
      overviewRows.map(([l, v]) => '<tr><td>' + esc(l) + '</td><td>' + esc(String(v)) + '</td></tr>').join('') +
      '</table></div></div>';

    // Top keywords card
    const kws = snap.topKeywords || [];
    document.getElementById('ads-keywords-card').innerHTML =
      '<div class="card"><div class="card-header"><h2>Top Keywords</h2>' +
      '<span class="section-note">by conversions</span></div>' +
      '<div class="card-body table-wrap">' +
      (kws.length === 0 ? '<p class="empty-state">No keyword data yet.</p>' :
        '<table><thead><tr><th>Keyword</th><th>Match</th><th>QS</th><th>Clicks</th><th>CVR</th><th>CPC</th><th>Conv</th></tr></thead><tbody>' +
        kws.map(k =>
          '<tr><td>' + esc(k.keyword || '—') + '</td>' +
          '<td>' + esc((k.matchType || '').toLowerCase()) + '</td>' +
          '<td>' + (k.qualityScore || '—') + '</td>' +
          '<td>' + fmtNum(k.clicks) + '</td>' +
          '<td>' + (k.clicks > 0 ? (k.conversions / k.clicks * 100).toFixed(1) + '%' : '—') + '</td>' +
          '<td>$' + (k.avgCpc || 0).toFixed(2) + '</td>' +
          '<td>' + k.conversions + '</td></tr>'
        ).join('') +
        '</tbody></table>') +
      '</div></div>';
  }
  ```

- [ ] **Step 6: Wire renderAdsTab into loadData**

  Find the `loadData` function (around line 1324). After the `renderCROTab(data)` call, add:
  ```js
  renderAdsTab(data);
  ```

- [ ] **Step 7: Run test to verify it passes**

  ```bash
  node tests/agents/dashboard-ads.test.js
  ```

  Expected: `✓ dashboard ads tab tests pass`

- [ ] **Step 8: Smoke test the dashboard**

  ```bash
  node agents/dashboard/index.js --open
  ```

  Verify: Paid Search tab appears, clicking it shows "No Google Ads data yet" (graceful empty state). The Paid Search tab's KPI strip shows 2 cards (Ad Spend and ROAS showing "—" or "0" if no data). CRO tab KPI strip is unchanged at 7 cards.

- [ ] **Step 9: Commit**

  ```bash
  git add agents/dashboard/index.js tests/agents/dashboard-ads.test.js
  git commit -m "feat: add Paid Search tab and KPI cards to dashboard"
  ```

---

## Task 8: Add google-ads-collector to setup-cron.sh

**Files:**
- Modify: `scripts/setup-cron.sh`

- [ ] **Step 1: Add the cron entry**

  In `scripts/setup-cron.sh`, add after `DAILY_GA4`:
  ```bash
  DAILY_GOOGLE_ADS="25 13 * * * cd \"$PROJECT_DIR\" && $NODE agents/google-ads-collector/index.js >> data/reports/scheduler/google-ads-collector.log 2>&1"
  ```

  Add `$DAILY_GOOGLE_ADS` to the `NEW_CRONTAB` block (after `$DAILY_GA4`).

  Add to the echo summary:
  ```bash
  echo "  Daily   06:25 PDT / 05:25 PST — google-ads-collector"
  ```

- [ ] **Step 2: Re-run setup-cron.sh to install**

  ```bash
  chmod +x scripts/setup-cron.sh && ./scripts/setup-cron.sh
  ```

  Verify with `crontab -l` — the google-ads-collector entry should appear.

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/setup-cron.sh
  git commit -m "feat: add google-ads-collector to daily cron schedule"
  ```

---

## Task 9: Enable campaign and verify end-to-end

- [ ] **Step 1: Collect a first snapshot manually**

  ```bash
  node agents/google-ads-collector/index.js --date 2026-03-18
  ```

  Check `data/snapshots/google-ads/2026-03-18.json` — confirm it has the expected fields.

- [ ] **Step 2: Start the dashboard and verify Paid Search tab**

  ```bash
  node agents/dashboard/index.js --open
  ```

  Click the Paid Search tab. Confirm Campaign Overview and Top Keywords cards render with real data.

- [ ] **Step 3: Enable the campaign in Google Ads UI**

  Open Google Ads → `RSC | Lotion | Search` → Change status from PAUSED to ENABLED. Confirm mobile bid adjustment is set to +30%.

- [ ] **Step 4: Final commit (if anything remains uncommitted)**

  All implementation files should have been committed in Tasks 1–8. Run `git status` to verify. If any files remain staged or modified, add them by name:

  ```bash
  git status
  # Add only files you recognize — never use git add . at this stage
  # Example if anything slipped through:
  # git add agents/dashboard/index.js agents/cro-analyzer/index.js
  git commit -m "feat: complete Google Ads campaign integration"
  ```
