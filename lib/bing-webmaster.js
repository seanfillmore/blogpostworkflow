/**
 * Bing Webmaster Tools API client
 *
 * The only query-level view of the index DuckDuckGo serves from. Bing itself is a
 * rounding error here (~28 clicks/month, $0 attributed revenue over 13 months), but
 * DDG converts new customers at 2.88% against Google organic's 0.60%, and this API
 * keeps ~6 months of history where GA4 now retains 2. That is the whole reason this
 * file exists — it is deliberately small.
 *
 * Required .env key:
 *   BINGWEBMASTER_API   (32-char key from Bing Webmaster Tools → Settings → API access)
 *
 * Optional:
 *   BING_SITE_URL       (defaults to DEFAULT_SITE_URL below)
 *
 * The verified property is the APEX domain `https://realskincare.com/` — NOT the `www`
 * host that GSC_SITE_URL uses. Passing the www form returns HTTP 400 / NotAuthorized.
 *
 * Credentials resolve from process.env FIRST and fall back to the .env file, so an
 * unattended cron that never sources .env still works, and so does a hand-run agent.
 * Nothing here ever prints the key: every error message carries a redacted URL.
 *
 * Three quirks of this API that the normalizers exist to absorb:
 *
 *   1. Rows arrive under `d`, and dates are Microsoft WCF strings —
 *      `/Date(1771315200000-0800)/`. The offset is NOT constant: the same account
 *      returns -0800 in winter rows and -0700 in summer rows, so the offset in the
 *      string has to be applied rather than assumed, or every PDT day lands one day
 *      early.
 *   2. Bing does not return CTR at all. GSC does. We compute it.
 *   3. Bing splits position in two — `AvgImpressionPosition` and `AvgClickPosition`,
 *      where GSC blends them into one `position`. `AvgClickPosition: -1` is a
 *      sentinel, not a rank. On this account it is -1 on EVERY row, including the
 *      153 rows that carry clicks, so treat click position as unavailable rather
 *      than as data.
 *
 * Two undocumented limits, both measured 2026-08-18:
 *
 *   - `GetQueryStats` and `GetPageStats` are sampled WEEKLY (26 dates, every one a
 *     Friday, exactly 7 days apart) while `GetRankAndTrafficStats` is daily across the
 *     same 177-day window. Query totals therefore land far below site totals — 163 vs
 *     167 clicks, 5,023 vs 13,224 impressions. That gap is the sampling, not data loss,
 *     and the two must never be reconciled against each other.
 *   - `GetQueryStats` caps at 100 rows PER DATE. Two of the 26 dates sit at exactly
 *     100, and on those dates the rows at the cap boundary — all of them 1 impression
 *     / 0 clicks — come back as a DIFFERENT subset on each call: two calls a second
 *     apart returned identical row counts and identical totals but 1,719 vs 1,722
 *     distinct queries. So one snapshot's query list is a truncated top-100, never the
 *     complete tail, and successive weekly snapshots accumulate coverage the single
 *     file cannot give. Pages never approached the cap (max 43 rows on a date).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEFAULT_ENV_FILE = join(ROOT, '.env');

/** The verified Bing property: apex, with the trailing slash Bing stores it under. */
export const DEFAULT_SITE_URL = 'https://realskincare.com/';

/**
 * Measured ceiling on `GetQueryStats` rows for a single date. Undocumented; there is
 * no parameter to raise it. A date sitting at this number is truncated, and which of
 * the tied 1-impression rows survive is not stable between calls.
 */
export const PER_DATE_ROW_CAP = 100;

const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

// ── env ───────────────────────────────────────────────────────────────────────

/** `KEY=value` lines of a .env file, or {} when it is missing or unreadable. */
function readEnvFile(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * process.env wins, then .env. Resolved lazily on each call rather than at import
 * time: lib/gsc.js and lib/ga4.js throw from module scope when .env is absent, which
 * makes them impossible to import in a test that stubs fetch.
 */
export function resolveCredentials({ env = process.env, envFile = DEFAULT_ENV_FILE } = {}) {
  const file = readEnvFile(envFile);
  const pick = (key) => {
    const v = env?.[key] ?? file[key];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  return {
    apiKey: pick('BINGWEBMASTER_API'),
    siteUrl: pick('BING_SITE_URL') || DEFAULT_SITE_URL,
  };
}

// ── normalizers ───────────────────────────────────────────────────────────────

const MS_DATE_RE = /^\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\/$/;

/**
 * Microsoft WCF date string → 'YYYY-MM-DD' in the offset the string declares.
 *
 * `/Date(1771315200000-0800)/` is epoch-UTC-millis followed by the local offset the
 * value was recorded in. Bing hands back midnight local, so applying the offset and
 * reading the UTC date gives the calendar day Bing means. Ignoring the offset (or
 * hardcoding one) shifts every PDT row back a day, which would silently misalign this
 * feed against every other snapshot in data/snapshots/.
 */
export function parseMicrosoftDate(value) {
  if (typeof value !== 'string') {
    throw new Error(`Bing date: expected a string, got ${typeof value}`);
  }
  const m = MS_DATE_RE.exec(value.trim());
  if (!m) throw new Error(`Bing date: unrecognized format "${value}"`);

  const epochMs = Number(m[1]);
  if (!Number.isFinite(epochMs)) throw new Error(`Bing date: bad epoch in "${value}"`);

  let shift = 0;
  if (m[2]) {
    const magnitude = Number(m[3]) * 60 + Number(m[4]);
    shift = (m[2] === '-' ? -1 : 1) * magnitude * 60_000;
  }
  return new Date(epochMs + shift).toISOString().slice(0, 10);
}

/**
 * Clicks ÷ impressions, rounded to 4dp to match the gsc snapshot's `ctr` precision.
 * Zero impressions is 0, never NaN or Infinity — a NaN here poisons every downstream
 * average silently.
 */
export function computeCtr(clicks, impressions) {
  const c = Number(clicks) || 0;
  const i = Number(impressions) || 0;
  if (i <= 0) return 0;
  return Math.round((c / i) * 10000) / 10000;
}

/**
 * Bing's position sentinel. `-1` means "no value", not "ranked minus one". Anything
 * not a finite positive number is unavailable, and unavailable is `null` so it drops
 * out of averages instead of dragging them toward zero.
 */
export function normalizePosition(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One `GetRankAndTrafficStats` row → { date, clicks, impressions, ctr }. */
export function normalizeTrafficRow(row) {
  const clicks = Number(row?.Clicks) || 0;
  const impressions = Number(row?.Impressions) || 0;
  return {
    date: parseMicrosoftDate(row?.Date),
    clicks,
    impressions,
    ctr: computeCtr(clicks, impressions),
  };
}

/**
 * One `GetQueryStats` / `GetPageStats` row. Both come back as the SAME `QueryStats`
 * type — GetPageStats puts the page URL in the `Query` field — so the caller says
 * which key the label belongs under.
 */
export function normalizeStatRow(row, labelKey = 'query') {
  const clicks = Number(row?.Clicks) || 0;
  const impressions = Number(row?.Impressions) || 0;
  return {
    [labelKey]: row?.Query ?? null,
    date: parseMicrosoftDate(row?.Date),
    clicks,
    impressions,
    ctr: computeCtr(clicks, impressions),
    impressionPosition: normalizePosition(row?.AvgImpressionPosition),
    clickPosition: normalizePosition(row?.AvgClickPosition),
  };
}

// ── core request ──────────────────────────────────────────────────────────────

/** The request URL with the key blanked out, safe to put in an error or a log. */
export function redactUrl(url) {
  return String(url).replace(/([?&]apikey=)[^&]*/i, '$1<redacted>');
}

/**
 * Throws on a non-200, on a non-JSON body, on an `{ErrorCode, Message}` payload (Bing
 * returns those with HTTP 400, but a 200 carrying one must not slip through either),
 * and on a response whose `d` is not an array. Never returns silently empty: a feed
 * whose failure mode is "zero rows" is indistinguishable from a quiet week, and this
 * snapshot is the only copy of the history once Bing's window rolls past.
 */
export async function bingRequest(method, { fetchImpl = fetch, ...options } = {}) {
  const { apiKey, siteUrl } = resolveCredentials(options);
  if (!apiKey) {
    throw new Error('Missing BINGWEBMASTER_API. Add it to .env (Bing Webmaster Tools → Settings → API access).');
  }

  const url = `${API_BASE}/${method}?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(siteUrl)}`;
  const safeUrl = redactUrl(url);

  const res = await fetchImpl(url);
  const text = await res.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Bing ${method}: HTTP ${res.status} — non-JSON response: ${text.slice(0, 200)} (${safeUrl})`);
  }

  if (payload && payload.ErrorCode !== undefined) {
    throw new Error(`Bing ${method}: HTTP ${res.status} — ErrorCode ${payload.ErrorCode}: ${payload.Message} (${safeUrl})`);
  }
  if (!res.ok) {
    throw new Error(`Bing ${method}: HTTP ${res.status} — ${text.slice(0, 200)} (${safeUrl})`);
  }
  if (!Array.isArray(payload?.d)) {
    throw new Error(`Bing ${method}: expected an array under "d", got ${JSON.stringify(payload)?.slice(0, 200)} (${safeUrl})`);
  }
  return payload.d;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * getRankAndTrafficStats()
 * Daily site totals for Bing's full retained window (~177 days / 6 months).
 * Returns: [{ date, clicks, impressions, ctr }] sorted ascending by date.
 */
export async function getRankAndTrafficStats(options = {}) {
  const rows = await bingRequest('GetRankAndTrafficStats', options);
  return rows.map(normalizeTrafficRow).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * getQueryStats()
 * Per-(query, date) rows. NOTE: this is a SAMPLE, not the full daily series — Bing
 * returns roughly one day a week (26 distinct dates against the traffic feed's 177),
 * so query totals will always come in below the site totals. Do not reconcile them.
 * Returns: [{ query, date, clicks, impressions, ctr, impressionPosition, clickPosition }]
 */
export async function getQueryStats(options = {}) {
  const rows = await bingRequest('GetQueryStats', options);
  return rows.map((r) => normalizeStatRow(r, 'query'));
}

/**
 * getPageStats()
 * Per-(page, date) rows, same sampling caveat as getQueryStats. Bing returns these in
 * the identical `QueryStats` shape with the URL in the `Query` field.
 * Returns: [{ page, date, clicks, impressions, ctr, impressionPosition, clickPosition }]
 */
export async function getPageStats(options = {}) {
  const rows = await bingRequest('GetPageStats', options);
  return rows.map((r) => normalizeStatRow(r, 'page'));
}
