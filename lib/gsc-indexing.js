/**
 * Google Search Console URL Inspection + Sitemaps + Indexing API wrappers.
 *
 * Three APIs, one module:
 *
 *   1. URL Inspection API  — searchconsole.googleapis.com/v1/urlInspection/index:inspect
 *      Authoritative "is this page indexed?" answer with full coverage state.
 *      Quota: 2000/minute, 600/day per property.
 *
 *   2. Sitemaps API        — webmasters.googleapis.com/v1/sites/:site/sitemaps/:path
 *      Resubmit a sitemap to nudge Google to re-crawl. Fully supported,
 *      no quotas worth worrying about.
 *
 *   3. Indexing API        — indexing.googleapis.com/v3/urlNotifications:publish
 *      Direct URL submission. Officially for JobPosting / BroadcastEvent only,
 *      but works for regular pages in practice. Hard quota: 200/day per project.
 *      We self-rate-limit to 10/day to preserve budget and stay in the spirit
 *      of the restriction.
 *
 * Auth: reuses the OAuth refresh token from lib/gsc.js (same env keys). The
 * token must have these scopes:
 *   https://www.googleapis.com/auth/webmasters        (read+write)
 *   https://www.googleapis.com/auth/indexing
 *
 * Re-run scripts/gsc-auth.js after the scope upgrade to get a fresh token.
 *
 * Quota tracking: writes a daily counter to data/quota/indexing-api.json so
 * the indexing-fixer agent can defer submissions when approaching the limit.
 * See docs/signal-manifest.md.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_URL } from './gsc.js'; // inherits token management and SITE_URL

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const QUOTA_DIR = join(ROOT, 'data', 'quota');
const QUOTA_FILE = join(QUOTA_DIR, 'indexing-api.json');

export const DAILY_INDEXING_SUBMISSION_CAP = 10;  // self-imposed, under 200 hard quota
export const DAILY_URL_INSPECTION_CAP = 500;      // under 600 hard quota (headroom)

// ── token management (shares refresh token with lib/gsc.js) ───────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnv();
const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = env.GOOGLE_REFRESH_TOKEN;

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
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── quota tracking ───────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function loadQuota() {
  if (!existsSync(QUOTA_FILE)) return { date: today(), inspection: 0, submission: 0 };
  try {
    const data = JSON.parse(readFileSync(QUOTA_FILE, 'utf8'));
    // Roll over at midnight UTC
    if (data.date !== today()) return { date: today(), inspection: 0, submission: 0 };
    return data;
  } catch {
    return { date: today(), inspection: 0, submission: 0 };
  }
}

function saveQuota(quota) {
  mkdirSync(QUOTA_DIR, { recursive: true });
  writeFileSync(QUOTA_FILE, JSON.stringify(quota, null, 2));
}

function bumpQuota(kind) {
  const q = loadQuota();
  q[kind] = (q[kind] || 0) + 1;
  saveQuota(q);
  return q;
}

/**
 * Returns { inspection: { used, cap, remaining }, submission: { used, cap, remaining } }
 */
export function getQuotaStatus() {
  const q = loadQuota();
  return {
    date: q.date,
    inspection: {
      used: q.inspection || 0,
      cap: DAILY_URL_INSPECTION_CAP,
      remaining: Math.max(0, DAILY_URL_INSPECTION_CAP - (q.inspection || 0)),
    },
    submission: {
      used: q.submission || 0,
      cap: DAILY_INDEXING_SUBMISSION_CAP,
      remaining: Math.max(0, DAILY_INDEXING_SUBMISSION_CAP - (q.submission || 0)),
    },
  };
}

// ── URL Inspection API ────────────────────────────────────────────────────────

/**
 * Inspect a single URL. Returns a normalized object. Throws on quota exhaustion
 * or permission errors — callers should catch and downgrade to a deferred state.
 *
 * Response shape (normalized from the raw API):
 *   {
 *     url,
 *     state: 'indexed' | 'submitted_not_indexed' | 'discovered_not_crawled' |
 *            'crawled_not_indexed' | 'excluded_noindex' | 'excluded_robots' |
 *            'excluded_canonical' | 'not_found' | 'unknown',
 *     coverage_state,        // raw string from API, e.g. "Submitted and indexed"
 *     indexing_state,        // "INDEXING_ALLOWED" / "BLOCKED_BY_*"
 *     last_crawl,            // ISO string or null
 *     google_canonical,      // URL Google chose as canonical
 *     user_canonical,        // URL your page declared
 *     canonical_mismatch,    // boolean — true if Google picked a different canonical
 *     page_fetch_state,      // "SUCCESSFUL" / "SOFT_404" / "NOT_FOUND" / "ACCESS_DENIED"
 *     robots_txt_state,      // "ALLOWED" / "DISALLOWED"
 *     raw                    // full API response for audit trail
 *   }
 */
export async function inspectUrl(url) {
  const q = loadQuota();
  if ((q.inspection || 0) >= DAILY_URL_INSPECTION_CAP) {
    throw new Error(`URL inspection quota exhausted (${DAILY_URL_INSPECTION_CAP}/day)`);
  }

  const token = await getAccessToken();
  const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inspectionUrl: url,
      siteUrl: SITE_URL,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error(`Rate limited — ${text}`);
    if (res.status === 403) throw new Error(`Permission denied — is the OAuth account a verified owner? ${text}`);
    throw new Error(`URL inspection failed: HTTP ${res.status} — ${text}`);
  }

  bumpQuota('inspection');

  const data = await res.json();
  return classifyInspection(url, data);
}

/**
 * Turn the raw URL Inspection response into one of our normalized states.
 *
 * Google's API returns a verdict ("PASS"/"FAIL"/"NEUTRAL") plus a coverageState
 * string that describes what actually happened. We classify on coverageState
 * because it's more specific and stable across verdict changes.
 */
function classifyInspection(url, raw) {
  const result = raw.inspectionResult || {};
  const index = result.indexStatusResult || {};
  const coverage = index.coverageState || '';
  const robots = index.robotsTxtState || '';
  const indexing = index.indexingState || '';
  const pageFetch = index.pageFetchState || '';
  const googleCanonical = index.googleCanonical || null;
  const userCanonical = index.userCanonical || null;
  const lastCrawl = index.lastCrawlTime || null;

  let state = 'unknown';
  const c = coverage.toLowerCase();

  if (c.includes('submitted and indexed') || c.includes('indexed, not submitted')) {
    state = 'indexed';
  } else if (c.includes('duplicate') && c.includes('canonical')) {
    state = 'excluded_canonical';
  } else if (c.includes('submitted and not indexed') || c.includes('submitted, not indexed')) {
    state = 'submitted_not_indexed';
  } else if (c.includes('discovered') && c.includes('currently not indexed')) {
    state = 'discovered_not_crawled';
  } else if (c.includes('crawled') && c.includes('currently not indexed')) {
    state = 'crawled_not_indexed';
  } else if (robots.toLowerCase().includes('disallowed') || indexing === 'BLOCKED_BY_ROBOTS_TXT') {
    state = 'excluded_robots';
  } else if (indexing === 'BLOCKED_BY_META_TAG' || c.includes('noindex')) {
    state = 'excluded_noindex';
  } else if (pageFetch === 'NOT_FOUND' || pageFetch === 'SOFT_404') {
    state = 'not_found';
  } else if (c.includes('url is unknown') || c === '') {
    state = 'unknown';
  }

  // Canonical mismatch: Google chose a different URL than what we declared.
  // This is a real ranking killer and worth flagging even when technically "indexed".
  const canonicalMismatch = !!(googleCanonical && userCanonical && googleCanonical !== userCanonical);

  return {
    url,
    state,
    coverage_state: coverage,
    indexing_state: indexing,
    last_crawl: lastCrawl,
    google_canonical: googleCanonical,
    user_canonical: userCanonical,
    canonical_mismatch: canonicalMismatch,
    page_fetch_state: pageFetch,
    robots_txt_state: robots,
    raw,
  };
}

// ── Sitemaps API ─────────────────────────────────────────────────────────────

/**
 * Resubmit a sitemap to trigger a re-crawl. Safe to call — fully supported API,
 * no quota concerns. Returns { ok, status } or throws on auth/permission error.
 *
 * sitemapUrl: full URL to the sitemap (e.g. https://www.realskincare.com/sitemap.xml)
 */
export async function resubmitSitemap(sitemapUrl) {
  const token = await getAccessToken();
  const encodedSiteUrl = encodeURIComponent(SITE_URL);
  const encodedSitemap = encodeURIComponent(sitemapUrl);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/sitemaps/${encodedSitemap}`;

  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`Sitemap resubmit failed: HTTP ${res.status} — ${text}`);
  }
  return { ok: true, status: res.status };
}

// ── Indexing API ─────────────────────────────────────────────────────────────

/**
 * Submit a URL for indexing via Google's Indexing API.
 *
 * Officially scoped to JobPosting / BroadcastEvent pages per Google's docs:
 * https://developers.google.com/search/apis/indexing-api/v3/quickstart
 *
 * In practice works for regular blog posts too. We self-limit to 10/day so
 * usage stays conservative, and we log every submission for audit trail in
 * case Google enforces the restriction in the future.
 *
 * type: 'URL_UPDATED' (new or changed) | 'URL_DELETED'
 */
export async function submitUrlForIndexing(url, type = 'URL_UPDATED') {
  if (type !== 'URL_UPDATED' && type !== 'URL_DELETED') {
    throw new Error(`Invalid submission type: ${type}`);
  }

  const q = loadQuota();
  if ((q.submission || 0) >= DAILY_INDEXING_SUBMISSION_CAP) {
    throw new Error(`Indexing submission quota exhausted (${DAILY_INDEXING_SUBMISSION_CAP}/day self-limit)`);
  }

  const token = await getAccessToken();
  const res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, type }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403) throw new Error(`Indexing API permission denied — verify owner status in GSC. ${text}`);
    if (res.status === 429) throw new Error(`Indexing API rate limited — ${text}`);
    throw new Error(`Indexing submission failed: HTTP ${res.status} — ${text}`);
  }

  bumpQuota('submission');

  const data = await res.json();
  return {
    ok: true,
    url,
    type,
    submitted_at: new Date().toISOString(),
    notification_time: data.urlNotificationMetadata?.latestUpdate?.notifyTime || null,
  };
}
