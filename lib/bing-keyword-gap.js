/**
 * Join Bing query data against data/keyword-index.json and surface commercial-intent
 * queries the privacy-selecting audience uses that we do not currently target.
 *
 * Everything here is pure so agents/bing-keyword-gap can be tested from fixtures with
 * no network and no snapshot on disk.
 *
 * ── What this is for, and what it is emphatically not ────────────────────────────
 *
 * Bing is ~28 clicks/month and $0 attributed revenue over 13 months. Nobody should
 * chase Bing. The feed is kept because Bing's index serves DuckDuckGo, and DDG has
 * converted new customers at 2.88% against Google organic's 0.60% — so Bing's query
 * list is the only readable proxy for what a privacy-selecting audience searches.
 *
 * This module NEVER writes data/keyword-index.json. Fifteen agents read that file, it
 * is built on the server by agents/keyword-index-builder, and folding a channel this
 * small into it would pollute a shared input with a source that has never produced a
 * dollar. The output is a report.
 *
 * ── Three properties of the Bing feed that shape every function below ────────────
 *
 *  1. Query rows are a WEEKLY SAMPLE (26 dates, all Fridays) while the traffic feed is
 *     daily across 177 days. Query totals (163 clicks / 5,023 impressions) therefore sit
 *     far below site totals (167 / 13,224). They must never be reconciled. Consequently
 *     every absolute dollar figure in this module is derived from the DAILY feed, and
 *     query-level numbers are used only for RELATIVE ranking and share.
 *  2. `GetQueryStats` caps at 100 rows per date and the truncated tail is unstable —
 *     successive calls returned 1,718/1,719/1,720/1,722 distinct queries as tied
 *     1-impression rows rotated. A single snapshot is a truncated top-100 per date, so
 *     absence from it is never evidence a query does not exist.
 *  3. `clickPosition` is null on every row (Bing returns -1 universally on this
 *     account). Nothing here ranks on it. `impressionPosition` is real and is used.
 */

import { normalize, slug as toSlug } from './keyword-index/normalize.js';
import { assignCluster } from './keyword-index/cluster.js';
import { classifySearchIntent } from './search-intent.js';

/** Trailing-90d AOV. Structural break ~2025-09; never average across it. */
export const DEFAULT_AOV = 50.46;
/** New-customer CVR measured on DuckDuckGo (p=0.001, 12.5-month sample). */
export const DDG_NEW_CUSTOMER_CVR = 0.0288;
/** Google organic's new-customer CVR over the same sample — the pessimistic anchor. */
export const GOOGLE_ORGANIC_CVR = 0.0060;

const DAYS_PER_MONTH = 30.437;

// ── host normalisation ────────────────────────────────────────────────────────

/**
 * The Bing property is the APEX `https://realskincare.com/` while GSC_SITE_URL and the
 * keyword index's `gsc.top_page` use `www`. Comparing the two raw would report every
 * page as unmatched. Strip scheme, leading `www.`, and any trailing slash.
 */
export function normalizeUrl(url) {
  if (!url) return null;
  return String(url)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// ── branded separation ────────────────────────────────────────────────────────

/**
 * Branded queries must be split out: `real skincare` alone is 20 of 167 clicks, and a
 * gap report dominated by our own name is useless. We already rank #1 for ourselves.
 *
 * Three layers, because the corpus proved one is not enough:
 *   a) lib/keyword-index/cluster.js's own `brand` rule — the house definition, reused.
 *   b) `config/site.json:brand_terms` — the house config, which also carries `culina`
 *      (a separate brand on a separate site; it must never appear in an RSC report).
 *   c) a token rule for misspellings, because the real feed contains `reale skin care`
 *      (42 impressions) and `real skin` (16), and cluster.js's regex requires the
 *      literal `real skin care` / `realskin` so it lets both through as 'unclustered'.
 *      A query carrying a real*-ish token AND a skin*-ish token is us.
 */
export function isBranded(query, brandTerms = []) {
  const q = normalize(query);
  if (!q) return false;
  if (assignCluster(q) === 'brand') return true;

  const compact = q.replace(/[^a-z0-9]/g, '');
  for (const term of brandTerms) {
    const t = String(term || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (t && compact.includes(t)) return true;
  }

  const tokens = q.split(/\s+/);
  const hasReal = tokens.some((t) => /^reals?e?s?$/.test(t));
  const hasSkin = tokens.some((t) => /^skin(care|s)?$/.test(t));
  return hasReal && hasSkin;
}

// ── the clean-ingredient angle ────────────────────────────────────────────────

/**
 * The transferable finding from the DDG work: the privacy-selecting audience responds
 * to the "non-toxic / clean-ingredient" angle far better than the general audience.
 *
 * This is an ANGLE tag, not an intent test — it says "this query is worded the way that
 * audience words things", which is why it is scored separately from commercial intent
 * rather than folded into it. The lexicon is grounded in config/site.json's seed_topics
 * and the ingredient-avoidance language the cluster already ranks for (sls-free,
 * fluoride-free, aluminium-free), not invented.
 */
export const CLEAN_ANGLE_PATTERNS = [
  /\bnon[\s-]?toxic\b/, /\bnontoxic\b/, /\bchemical[\s-]?free\b/,
  /\b(alumin[iu]?m|fluoride|sls|sulfates?|parabens?|paraffin|phthalates?)[\s-]?free\b/,
  /\bfree of\b/, /\bwithout\s+(sls|fluoride|alumin[iu]?m|parabens?|sulfates?|chemicals?)\b/,
  /\bnatural\b/, /\borganic\b/, /\bclean\b/, /\bsafe\b/, /\bplant[\s-]?based\b/,
  /\bingredients?\b/, /\bnon[\s-]?gmo\b/, /\bcruelty[\s-]?free\b/,
];

export function hasCleanAngle(query) {
  const q = normalize(query);
  return CLEAN_ANGLE_PATTERNS.some((p) => p.test(q));
}

// ── aggregation ───────────────────────────────────────────────────────────────

/**
 * Collapse the per-(query, date) rows onto one row per normalized query.
 *
 * Position is impression-weighted, not a plain mean: a query seen 160 times at
 * position 3 and once at position 40 sits at 3, not at 21.
 */
export function aggregateQueries(snapshot) {
  const acc = new Map();
  for (const r of snapshot?.queries || []) {
    const key = normalize(r.query);
    if (!key) continue;
    let e = acc.get(key);
    if (!e) {
      e = { key, query: r.query, clicks: 0, impressions: 0, _posWeight: 0, _posSum: 0, dates: new Set() };
      acc.set(key, e);
    }
    e.clicks += Number(r.clicks) || 0;
    e.impressions += Number(r.impressions) || 0;
    if (r.date) e.dates.add(r.date);
    const p = r.impressionPosition;
    const imp = Number(r.impressions) || 0;
    if (p != null && Number.isFinite(p) && imp > 0) {
      e._posSum += p * imp;
      e._posWeight += imp;
    }
  }
  return [...acc.values()].map((e) => {
    const dates = [...e.dates].sort();
    return {
      key: e.key,
      query: e.query,
      clicks: e.clicks,
      impressions: e.impressions,
      ctr: e.impressions > 0 ? Math.round((e.clicks / e.impressions) * 10000) / 10000 : 0,
      position: e._posWeight > 0 ? Math.round((e._posSum / e._posWeight) * 10) / 10 : null,
      weeks: dates.length,
      firstSeen: dates[0] ?? null,
      lastSeen: dates.at(-1) ?? null,
    };
  });
}

// ── the feed's own CTR baseline, and zero-click anomalies ─────────────────────

const BUCKETS = [
  ['1-3', (p) => p <= 3],
  ['4-5', (p) => p <= 5],
  ['6-10', (p) => p <= 10],
  ['11+', () => true],
];

export function positionBucket(position) {
  if (position == null || !Number.isFinite(position)) return null;
  return BUCKETS.find(([, test]) => test(position))[0];
}

/**
 * CTR per position bucket computed from the feed itself, so "normal" is this account's
 * normal rather than an industry table. `excludeKeys` lets a caller hold one query out
 * and ask what the rest of the feed does at the same positions — which is exactly how
 * you tell a CTR leak apart from a row that was never human.
 */
export function ctrBaseline(rows, { excludeKeys = [] } = {}) {
  const skip = new Set(excludeKeys);
  const acc = {};
  for (const r of rows || []) {
    const b = positionBucket(r.position);
    if (!b || skip.has(r.key)) continue;
    acc[b] = acc[b] || { impressions: 0, clicks: 0, queries: 0 };
    acc[b].impressions += r.impressions;
    acc[b].clicks += r.clicks;
    acc[b].queries += 1;
  }
  for (const b of Object.keys(acc)) {
    acc[b].ctr = acc[b].impressions > 0 ? acc[b].clicks / acc[b].impressions : 0;
  }
  return acc;
}

/**
 * Is this row's zero-click record explainable as chance, given what the REST of the feed
 * does at the same position?
 *
 * Returns the natural log of P(0 clicks | n impressions at the peer CTR). Log, because
 * the interesting cases underflow a float: 1,467 impressions at 11.4% gives e^-177.
 *
 * This exists because the single largest apparent opportunity in the 2026-08-18 snapshot
 * — `dr bronner alternative`, 1,551 impressions at position 2-3, 33% of all non-branded
 * impressions — has zero clicks, while every OTHER query in the same feed at positions
 * 1-3 clicks at 11.41%. A row that cannot be a coincidence is not a CTR leak to fix; it
 * is impressions with no human behind them, and counting it in a revenue ceiling
 * inflates that ceiling roughly fourfold.
 */
export function logProbZeroClicks(row, baseline) {
  const b = positionBucket(row.position);
  const peer = b && baseline[b];
  if (!peer || !(peer.ctr > 0) || row.impressions <= 0) return 0;
  return row.impressions * Math.log(1 - peer.ctr);
}

/**
 * A row is a phantom when it has clicked zero times, has enough impressions to have
 * spoken, and its silence is beyond `logThreshold` (default ln(1e-6) ≈ -13.8) against
 * its positional peers.
 *
 * The baseline MUST be a leave-one-out baseline — see detectPhantoms. Testing a row
 * against a baseline that contains the row is circular, and self-defeating in exactly
 * the case that matters: `dr bronner alternative` is 65% of all position-1-3
 * impressions in this feed, so including it drags the peer CTR from 11.41% down to
 * 3.62% and the row is then partly being compared against itself.
 */
export function isPhantom(row, baseline, { minImpressions = 100, logThreshold = Math.log(1e-6) } = {}) {
  if (row.clicks > 0 || row.impressions < minImpressions) return false;
  return logProbZeroClicks(row, baseline) < logThreshold;
}

/**
 * Find every phantom in a row set, each tested against a baseline computed with that
 * row held out. Returns { keys:Set, rows:[], baseline } where `baseline` excludes ALL
 * detected phantoms — that is the one a report should quote when it says "every other
 * query at this position clicks at X".
 *
 * Only zero-click rows above the impression floor are candidates, so the repeated
 * baseline computation is over a handful of rows, not the whole feed.
 */
export function detectPhantoms(rows, opts = {}) {
  const { minImpressions = 100 } = opts;
  const candidates = (rows || []).filter((r) => r.clicks === 0 && r.impressions >= minImpressions);
  const found = [];
  for (const r of candidates) {
    const loo = ctrBaseline(rows, { excludeKeys: [r.key] });
    if (isPhantom(r, loo, opts)) found.push(r);
  }
  const keys = new Set(found.map((r) => r.key));
  return { keys, rows: found, baseline: ctrBaseline(rows, { excludeKeys: [...keys] }) };
}

// ── page candidates ───────────────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'for', 'to', 'of', 'and', 'in', 'is', 'are', 'with', 'best', 'my', 'you', 'your']);

function contentTokens(text) {
  return normalize(text).split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

/**
 * Do we already own a page that could rank for this query? Answered from two inventories:
 * pages Bing already shows for this site (strongest evidence — Bing has indexed it and
 * is willing to rank it) and data/blog-index.json (a page that exists but Bing has not
 * surfaced). Bing's API gives no query→page join, so this is a token-overlap match and
 * is reported as a candidate, never as a certainty.
 */
export function findCandidatePage(query, { pages = [], blogIndex = null } = {}) {
  const qt = contentTokens(query);
  if (!qt.length) return null;

  const score = (text) => {
    const t = new Set(contentTokens(text));
    const hit = qt.filter((w) => t.has(w)).length;
    return hit / qt.length;
  };

  let best = null;
  for (const p of pages) {
    const path = normalizeUrl(p.page || p.url || p);
    if (!path) continue;
    const s = score(path.replace(/[/\-]/g, ' '));
    if (s >= 0.6 && (!best || s > best.score)) best = { url: p.page || p.url || p, score: s, source: 'bing-indexed' };
  }
  if (best) return best;

  for (const blog of blogIndex || []) {
    for (const a of blog?.articles || []) {
      const s = Math.max(score(a.title || ''), score(a.handle || ''));
      if (s >= 0.6 && (!best || s > best.score)) {
        best = { url: `https://www.realskincare.com/blogs/${blog.handle}/${a.handle}`, score: s, source: 'blog-index' };
      }
    }
  }
  return best;
}

// ── the join ──────────────────────────────────────────────────────────────────

/**
 * Join every aggregated Bing query against the keyword index and tag it.
 *
 * `targeted` is index MEMBERSHIP, which is the reuse of the index's intent decision:
 * anything in data/keyword-index.json has already cleared `classifyValidationSource`'s
 * behavioural bar (Amazon purchases/clicks, GA4 conversions, or the untapped feed). We
 * do not re-derive that bar from text — we ask whether the index holds the query, using
 * the index's own `slug()` key so the join is exact rather than approximate.
 */
export function joinAgainstIndex(rows, index, { brandTerms = [], pages = [], blogIndex = null } = {}) {
  const keywords = index?.keywords || {};
  const { keys: phantomKeys } = detectPhantoms(rows);

  return rows.map((r) => {
    const entry = keywords[toSlug(r.key)] || null;
    const branded = isBranded(r.key, brandTerms);
    const intent = classifySearchIntent(r.key);
    return {
      ...r,
      branded,
      cluster: assignCluster(r.key),
      intent,
      // `product` is the only commercial bucket, by explicit equality rather than a
      // negation — `supply` (soap base, lye, base oils) must land on the false side, and
      // a "not diy/informational" test would have quietly put it on the true one.
      commercial: intent === 'product',
      cleanAngle: hasCleanAngle(r.key),
      targeted: Boolean(entry),
      validationSource: entry?.validation_source ?? null,
      indexCluster: entry?.cluster ?? null,
      phantom: phantomKeys.has(r.key),
      candidatePage: null, // filled lazily for shortlisted rows only — the match is O(n·m)
      _pagesCtx: null,
    };
  }).map((r) => {
    // Resolve the page candidate only where it can matter: an untargeted, non-branded,
    // commercial row. Matching all 1,714 rows against every article is wasted work.
    if (!r.branded && r.commercial && !r.targeted && !r.phantom) {
      r.candidatePage = findCandidatePage(r.key, { pages, blogIndex });
    }
    delete r._pagesCtx;
    return r;
  });
}

/**
 * The gap set: non-branded, commercial-intent, not in the keyword index, not a phantom.
 *
 * Ranked by plausible revenue rather than volume. The score is impressions × the
 * clickable-CTR the feed itself shows at that position × a clean-angle multiplier —
 * i.e. what the row could realistically deliver in CLICKS, not how loud it is. A
 * 1,500-impression row that never clicks scores zero, which is the entire point.
 */
export function rankGaps(joined, { baseline = null, cleanAngleBoost = 1.5 } = {}) {
  const base = baseline || ctrBaseline(joined);
  return joined
    .filter((r) => !r.branded && r.commercial && !r.targeted && !r.phantom)
    .map((r) => {
      const b = positionBucket(r.position);
      const peerCtr = (b && base[b]?.ctr) || 0;
      const expectedClicks = r.impressions * peerCtr;
      return {
        ...r,
        peerCtr: Math.round(peerCtr * 10000) / 10000,
        expectedClicks: Math.round(expectedClicks * 100) / 100,
        score: Math.round(expectedClicks * (r.cleanAngle ? cleanAngleBoost : 1) * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score || b.impressions - a.impressions);
}

// ── the dollar ceiling ────────────────────────────────────────────────────────

/**
 * P(observing `conversions` or fewer | `sessions` trials at rate `cvr`).
 *
 * Used to test the premise this whole report rests on. DDG's 2.88% is measured on DDG
 * sessions; applying it to BING sessions is an assumption, and Bing's own 13-month
 * record is the test of it. Computed in log space with a running sum so 253 trials do
 * not underflow.
 */
export function binomialTailAtMost(conversions, sessions, cvr) {
  if (sessions <= 0) return 1;
  const q = 1 - cvr;
  let logTerm = sessions * Math.log(q); // k = 0
  let total = Math.exp(logTerm);
  for (let k = 1; k <= conversions; k++) {
    logTerm += Math.log((sessions - k + 1) / k) + Math.log(cvr) - Math.log(q);
    total += Math.exp(logTerm);
  }
  return Math.min(1, total);
}

/**
 * The ceiling, in dollars per month.
 *
 * Built ONLY from the daily traffic feed — the one series in this snapshot that is not
 * sampled and not row-capped. Query-level impressions never enter a dollar figure; they
 * only supply the non-branded SHARE, which is a ratio and survives sampling.
 *
 * `upliftFactor` is the multiple of current non-branded Bing clicks the work is assumed
 * to win. 2.0 means "we double every non-branded click Bing sends" — already a heroic
 * assumption for a channel whose queries we mostly rank top-5 on.
 */
export function estimateCeiling({
  snapshot,
  nonBrandedClickShare,
  upliftFactor = 2.0,
  cvr = DDG_NEW_CUSTOMER_CVR,
  aov = DEFAULT_AOV,
}) {
  const days = snapshot?.range?.days || 0;
  const clicks = snapshot?.summary?.clicks || 0;
  const monthlyClicks = days > 0 ? (clicks / days) * DAYS_PER_MONTH : 0;
  const monthlyNonBranded = monthlyClicks * nonBrandedClickShare;
  const incrementalClicks = monthlyNonBranded * (upliftFactor - 1);
  return {
    days,
    totalClicks: clicks,
    monthlyClicks: Math.round(monthlyClicks * 10) / 10,
    monthlyNonBrandedClicks: Math.round(monthlyNonBranded * 10) / 10,
    upliftFactor,
    incrementalClicks: Math.round(incrementalClicks * 10) / 10,
    cvr,
    aov,
    monthlyRevenue: Math.round(incrementalClicks * cvr * aov * 100) / 100,
    annualRevenue: Math.round(incrementalClicks * cvr * aov * 12 * 100) / 100,
  };
}
