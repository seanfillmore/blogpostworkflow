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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('fetchGA4Snapshot: date must be YYYY-MM-DD, got: ' + date);
  }
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
  // Bumped from 25 → 1000 so the keyword-index builder's GSC→GA4 join
  // (which uses landingPage as the pivot) finds enough pages.
  const pagesReport = await runReport({
    dateRanges: [dateRange],
    dimensions: [{ name: 'landingPage' }],
    metrics: [
      { name: 'sessions' },
      { name: 'conversions' },
      { name: 'totalRevenue' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 1000,
  });

  const topLandingPages = (pagesReport.rows || []).map(row => ({
    page:        row.dimensionValues[0].value,
    sessions:    Math.round(parseFloat(row.metricValues[0].value)),
    conversions: Math.round(parseFloat(row.metricValues[1].value)),
    revenue:     Math.round(parseFloat(row.metricValues[2].value) * 100) / 100,
  }));

  // Call 4: site-wide device breakdown (desktop / mobile / tablet)
  // This is the ground truth for device weighting in SEO decisions — we now
  // know sessions, conversions, and revenue per device, not just sessions.
  const devicesReport = await runReport({
    dateRanges: [dateRange],
    dimensions: [{ name: 'deviceCategory' }],
    metrics: [
      { name: 'sessions' },
      { name: 'conversions' },
      { name: 'sessionConversionRate' },
      { name: 'totalRevenue' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  });

  const devices = (devicesReport.rows || []).map(row => ({
    device:         row.dimensionValues[0].value,
    sessions:       Math.round(parseFloat(row.metricValues[0].value)),
    conversions:    Math.round(parseFloat(row.metricValues[1].value)),
    conversionRate: Math.round(parseFloat(row.metricValues[2].value) * 1000) / 1000,
    revenue:        Math.round(parseFloat(row.metricValues[3].value) * 100) / 100,
  }));

  // Call 5: landing page × device breakdown
  // For each top landing page, what's the per-device split? This is what
  // drives per-page device weighting — a post that converts from desktop but
  // not mobile should prioritize desktop rankings for that keyword.
  const pagesByDeviceReport = await runReport({
    dateRanges: [dateRange],
    dimensions: [{ name: 'landingPage' }, { name: 'deviceCategory' }],
    metrics: [
      { name: 'sessions' },
      { name: 'conversions' },
      { name: 'totalRevenue' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 150, // 50 pages × 3 devices headroom
  });

  const landingPagesByDevice = (pagesByDeviceReport.rows || []).map(row => ({
    page:        row.dimensionValues[0].value,
    device:      row.dimensionValues[1].value,
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
    devices,
    landingPagesByDevice,
  };
}
