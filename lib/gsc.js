/**
 * Shared Google Search Console API client
 *
 * Uses OAuth 2.0 refresh token (stored in .env) to obtain access tokens
 * automatically. All methods are async and return plain JS objects.
 *
 * Required .env keys:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *   GSC_SITE_URL  (e.g. sc-domain:realskincare.com)
 *
 * Setup: node scripts/gsc-auth.js
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
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

const env = loadEnv();
const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = env.GOOGLE_REFRESH_TOKEN;
export const SITE_URL = env.GSC_SITE_URL;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !SITE_URL) {
  throw new Error(
    'Missing GSC credentials in .env. Run: node scripts/gsc-auth.js\n' +
    'Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GSC_SITE_URL'
  );
}

// ── token management ──────────────────────────────────────────────────────────

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
    throw new Error(`GSC token refresh failed: HTTP ${res.status} — ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh 60s early
  return cachedToken;
}

// ── core request ──────────────────────────────────────────────────────────────

async function gscQuery(body) {
  const token = await getAccessToken();
  const encodedSite = encodeURIComponent(SITE_URL);
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`;

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
    throw new Error(`GSC API error: HTTP ${res.status} — ${text}`);
  }

  const data = await res.json();
  return data.rows || [];
}

// ── date helpers ──────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function today() {
  // GSC data lags ~3 days
  return daysAgo(3);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * getTopKeywords(limit, days)
 * Top queries by impressions over the last N days.
 * Returns: [{ keyword, clicks, impressions, ctr, position }]
 */
export async function getTopKeywords(limit = 100, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['query'],
    rowLimit: limit,
    orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
  });

  return rows.map((r) => ({
    keyword: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

/**
 * getPagePerformance(pageUrl, days)
 * Traffic metrics for a specific page URL.
 * Returns: { clicks, impressions, ctr, position }
 */
export async function getPagePerformance(pageUrl, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['page'],
    dimensionFilterGroups: [{
      filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }],
    }],
    rowLimit: 1,
  });

  if (!rows.length) return { clicks: 0, impressions: 0, ctr: 0, position: null };
  const r = rows[0];
  return { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
}

/**
 * getPageKeywords(pageUrl, limit, days)
 * All queries driving traffic to a specific page.
 * Returns: [{ keyword, clicks, impressions, ctr, position }]
 */
export async function getPageKeywords(pageUrl, limit = 50, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['query'],
    dimensionFilterGroups: [{
      filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }],
    }],
    rowLimit: limit,
    orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
  });

  return rows.map((r) => ({
    keyword: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

/**
 * getKeywordPerformance(keyword, days)
 * Impressions, clicks, and position for a specific query.
 * Returns: { clicks, impressions, ctr, position }
 */
export async function getKeywordPerformance(keyword, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['query'],
    dimensionFilterGroups: [{
      filters: [{ dimension: 'query', operator: 'equals', expression: keyword }],
    }],
    rowLimit: 1,
  });

  if (!rows.length) return { clicks: 0, impressions: 0, ctr: 0, position: null };
  const r = rows[0];
  return { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
}

/**
 * getLowCTRKeywords(minImpressions, maxCTR, limit, days)
 * Queries getting significant impressions but low CTR — prime optimization targets.
 * Returns: [{ keyword, clicks, impressions, ctr, position }]
 */
export async function getLowCTRKeywords(minImpressions = 100, maxCTR = 0.05, limit = 50, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['query'],
    rowLimit: 1000,
    orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
  });

  return rows
    .filter((r) => r.impressions >= minImpressions && r.ctr <= maxCTR)
    .slice(0, limit)
    .map((r) => ({
      keyword: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));
}

/**
 * getPage2Keywords(limit, days)
 * Queries ranking on page 2 (positions 11–20) — quick-win ranking opportunities.
 * Returns: [{ keyword, clicks, impressions, ctr, position }]
 */
export async function getPage2Keywords(limit = 50, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['query'],
    rowLimit: 1000,
    orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
  });

  return rows
    .filter((r) => r.position > 10 && r.position <= 20)
    .slice(0, limit)
    .map((r) => ({
      keyword: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));
}

/**
 * getTopPages(limit, days)
 * Top pages by clicks.
 * Returns: [{ page, clicks, impressions, ctr, position }]
 */
export async function getTopPages(limit = 50, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['page'],
    rowLimit: limit,
    orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
  });

  return rows.map((r) => ({
    page: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

/**
 * getQuickWinPages(limit, days)
 * Pages ranking positions 5–20 — best internal-link leverage.
 * Groups by page URL, keeps the highest-impression query per page.
 * Returns: [{ keyword, url, position, impressions, clicks, ctr }]
 */
export async function getQuickWinPages(limit = 50, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['query', 'page'],
    rowLimit: 5000,
  });

  // Group by URL, keep best (highest impression) keyword per page
  const byUrl = new Map();
  for (const r of rows) {
    const [keyword, url] = r.keys;
    // Only keep positions 5–50 (quick wins + refresh tier)
    if (r.position < 5 || r.position > 50) continue;
    const existing = byUrl.get(url);
    if (!existing || r.impressions > existing.impressions) {
      byUrl.set(url, {
        keyword,
        url,
        position: r.position,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.ctr,
      });
    }
  }

  // Score same as internal-linker CSV mode
  const score = ({ position, impressions }) => {
    const vol = impressions || 0;
    if (position >= 5  && position <= 20) return vol * 3; // quick-win tier
    if (position >= 21 && position <= 50) return vol * 2; // refresh tier
    return 0;
  };

  return [...byUrl.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

/**
 * getAllQueryPageRows(limit, days)
 * Raw query+page rows — used for cannibalization analysis.
 * Returns: [{ query, page, clicks, impressions, ctr, position }]
 */
export async function getAllQueryPageRows(limit = 5000, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['query', 'page'],
    rowLimit: limit,
    orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
  });

  return rows.map((r) => ({
    query: r.keys[0],
    page: r.keys[1],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

/**
 * getSearchTrend(keyword, days)
 * Daily impression/click trend for a keyword over the last N days.
 * Returns: [{ date, clicks, impressions, ctr, position }]
 */
export async function getSearchTrend(keyword, days = 90) {
  const rows = await gscQuery({
    startDate: daysAgo(days),
    endDate: today(),
    dimensions: ['date'],
    dimensionFilterGroups: [{
      filters: [{ dimension: 'query', operator: 'equals', expression: keyword }],
    }],
    rowLimit: days,
  });

  return rows.map((r) => ({
    date: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}
