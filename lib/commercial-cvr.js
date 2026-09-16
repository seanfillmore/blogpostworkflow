/**
 * Conversion rate by LANDING-PAGE TYPE — the number the site-wide CVR cannot give.
 *
 * The site-wide rate (0.48-0.82%) counts blog sessions in its denominator, and blog
 * traffic converts near zero while earning 7% of revenue. That makes it useless for
 * "would paid traffic to a product page pay for itself", which is a question about
 * commercial pages only.
 *
 * Denominator: GA4 sessions by landing page.
 * Numerator:   Shopify orders by `landing_site` — ground truth, no modelling.
 *
 * SPLITTING BY PAGE TYPE WAS NOT ENOUGH, AND THE FIGURES THAT SPLIT PRODUCED ARE
 * UNSEGMENTED — do not quote them. This module reported blog 0.07% / commercial
 * 0.47% (2026-08-04 -> 08-29) and commercial 0.40% (2026-08-17 -> 09-13) while its
 * denominator still held bot traffic, sweepstakes traffic and non-US traffic. On
 * 2026-08-17 -> 09-13 that reads 0.40% commercial where the clean denominator
 * reads 0.68% — a 1.7x understatement of the affordable cost-per-click, and it is
 * the number paid-media decisions are made from.
 *
 * MEASURED by a live end-to-end run on 2026-09-15 for 2026-08-17 -> 2026-09-13.
 * Sessions per rung come from GA4; order counts come from Shopify `landing_site`:
 *
 *   rung                                   sessions   orders
 *   all sessions                             16,782       19
 *   non-US (Singapore the largest)            2,886        0
 *   US, sessionSource `(not set)`             4,373        0
 *   US sweepstakes-aggregator referrers       2,440        0
 *   US giveaway funnel, other sources         4,261        0
 *   CLEAN US SHOPPABLE                        2,822       17   (2 more have no landing page)
 *     of which product+collection               585        4  -> 0.68%
 *     blog, for contrast                      1,824        8  -> 0.44%
 *
 * A further 240 sessions land on a page GA4 truncated past recognition and are
 * reported as `unmappedSessions`, outside the ladder: 16,782 + 240 = 17,022, the
 * window's true session count.
 *
 * WHY EACH RUNG IS THERE, from the cross-tab that found them (engagedSessions as
 * the bot tell, against a 43% site average): `(not set)` engages at 2.5% — nothing
 * a human does looks like that. The sweepstakes and giveaway rungs are the
 * opposite problem, 86% and 77% engaged: real people, reading carefully, who are
 * not shoppers and never were.
 *
 * TWO SOURCES, AND THEY DISAGREE ABOUT ORDERS — read this before quoting a rate.
 * The ladder's sessions are GA4's; the orders are Shopify's, joined on the order's
 * own `landing_site`. Counting the same window with GA4's `ecommercePurchases`
 * instead gives commercial 6 orders / 578 sessions = 1.04% and blog 4, where
 * Shopify says commercial 4 / 585 = 0.68% and blog 8. SHOPIFY WINS ON ORDERS: it
 * is ground truth with no modelling, which is the whole reason this report joins
 * to it. The two attribute the same purchase to different landing pages often
 * enough to move the answer at this sample size, and that is a fact about the
 * measurement, not a rounding difference to average away.
 *
 * SO THE HONEST FIGURE IS ~0.7-1.0% ON 4-6 ORDERS. Quote the range. It sits
 * around the 1.03% US-PDP figure measured on 2026-09-03 by an entirely different
 * method — the GA4 daily snapshot's country breakdown (lib/ga4.js
 * fetchCountryBreakdown) — so ~1% is corroborated in shape by two independent
 * paths, neither tuned to reach the other. What is NOT corroborated is any
 * particular decimal.
 *
 * THE SAMPLE IS FOUR COMMERCIAL ORDERS. Directional, not a point estimate. The
 * same caution cluster revenue already demands: quote the shape, never the digit.
 *
 * Pure functions only — no I/O, so this is testable without stubbing a network.
 * The CLI that feeds it lives in scripts/commercial-page-cvr.mjs.
 */
import { pageTypeOf } from './order-attribution.js';

/**
 * The GA4 property was trashed and the hits discarded between 2026-07-27 and
 * 2026-08-03. Restoring a property does not recover them.
 *
 * This matters in ONE direction and it is the dangerous one: the hole removes
 * SESSIONS (the denominator) while Shopify orders (the numerator) are untouched,
 * so any window spanning it reports conversion HIGHER than reality. A tool whose
 * whole job is to say whether a rate clears breakeven must not fail optimistic.
 */
export const GA4_HOLE_END = '2026-08-03';

/**
 * Landing pages that must never be pooled with their page type.
 *
 * The giveaway lander took ~1,447 paid leads on a free-entry ask and 4,359 sessions
 * with zero orders. Inside the generic `page` bucket it drags an unrelated segment
 * to 0% and hides whatever else lives there. It is a different question (what does
 * a free offer convert at) wearing the same page type.
 *
 * Kept exported because callers may read it, but MATCHING goes through
 * isGiveawayPath() below — an exact set is not the rule, it is one member of it.
 */
export const GIVEAWAY_PATHS = new Set(['/pages/free-soap-giveaway']);

/**
 * THE GIVEAWAY FUNNEL IS FIVE PAGES, NOT ONE, and an exact-set test found one.
 *
 * Measured on the first live end-to-end run (2026-08-17 -> 09-13), landing pages
 * in the funnel and their sessions:
 *
 *   5,128  /pages/free-soap-giveaway        the lander — all the old rule caught
 *   1,192  /pages/giveaway-confirmed        POST-ENTRY: they have already entered
 *     377  /pages/giveaway-entered          POST-ENTRY
 *      30  /pages/giveaway-official-rules
 *       4  /pages/free-soap-givea=          GA4 truncation artifact, real sessions
 *       2  /pages/giveaway-entere=          "
 *       7  /pages/givea=                    "
 *
 * ~1,385 zero-order sessions were sitting in the generic `page` bucket, and the
 * script's CLEAN TOTAL read 4,150 against a hand measurement of 2,935. Somebody
 * who has just entered a free giveaway has no purchase intent at all; the
 * confirmation and entered pages are the same question as the lander.
 *
 * GA4's `landingPage` dimension TRUNCATES some URLs mid-path — that is where the
 * `givea=` spellings come from, and it is why literal equality can never be the
 * rule here. They are real sessions wearing a mangled label.
 *
 * SCOPED TO /pages/ AND DELIBERATELY NARROW, same doctrine as SWEEPSTAKES_TOKENS:
 * a false positive removes real traffic from the denominator, which makes CVR read
 * too HIGH. `/products/giveaway-soap-bundle` and `/blogs/news/our-giveaway-winners`
 * are unaffected because they are not `/pages/`.
 */
export const GIVEAWAY_PATH_PATTERN = /^\/pages\/[a-z0-9-]*givea/;

/** True when a landing path is anywhere in the giveaway funnel. */
export function isGiveawayPath(path, { giveawayPaths = GIVEAWAY_PATHS } = {}) {
  const norm = normalizeLandingPath(path);
  if (norm === null) return false;
  if (giveawayPaths.has(norm)) return true;
  return GIVEAWAY_PATH_PATTERN.test(norm.toLowerCase());
}

/** Page types that a paid campaign would actually point traffic at. */
export const COMMERCIAL_SEGMENTS = ['product', 'collection'];

// ── the exclusion ladder ─────────────────────────────────────────────────────
//
// Everything below answers one question: is this session capable of being a sale?
// A rung fires only on POSITIVE evidence, because the two mistakes are not
// symmetric. Leaving junk in the denominator makes CVR read too LOW (the defect
// being fixed, worth ~2.6x here). Excluding real traffic makes CVR read too HIGH,
// which is the same direction assertGa4WindowClean refuses outright — it would
// tell an operator paid traffic is affordable when it is not.
//
// So: UNKNOWN MEANS KEEP, everywhere, on both sides of the join.

/**
 * The two sides of the join name the same country differently, and both spellings
 * are needed: GA4's `country` dimension spells it out, Shopify's address
 * `country_code` is ISO-2.
 */
export const US_GA4_COUNTRY = 'United States';
export const US_COUNTRY_CODES = new Set(['US']);

/**
 * Sweepstakes-aggregator referrers measured in the 2026-08-17 -> 09-13 window.
 * These are giveaway-listing sites: 2,471 sessions at 86% engagement and ZERO
 * orders. Real people, reading carefully, with no intention of buying anything.
 */
export const SWEEPSTAKES_HOSTS = new Set([
  'contestgirl.com', 'freebieshark.com', 'sweepstakestoday.com', 'sweepsadvantage.com',
  // GA4 reports this one bare, with no TLD, in the measured window.
  'sweepsadvantage',
  'captainfreebie.com', 'freestufftimes.com', 'winprizesonline.com', 'vonbeau.com',
  'sweepstakesplus.com', 'freeprizesonline.com',
]);

/**
 * Tokens that catch an aggregator this window has not seen yet.
 *
 * DELIBERATELY NARROW, and it must stay that way. Bare `contest` and `prize` are
 * NOT here: `contestofchampions.com` and `prizepicks.com` are not giveaway
 * aggregators, and a false positive removes real traffic from the denominator,
 * which is the direction that makes CVR read too high. Same whitelist doctrine as
 * PRODUCT_NOUNS in lib/product-category-terms.js — an unrecognised host is a MISS,
 * never a block. Widen it only against a measured referrer list.
 */
export const SWEEPSTAKES_TOKENS = /sweepstake|sweeps|freebie|freestuff|winprizes|freeprizes/;

/** Reason strings, in the order the ladder applies them. */
export const EXCLUSION_REASONS = Object.freeze([
  'non-us', 'no-source', 'sweepstakes-referrer', 'giveaway-lander',
]);

/**
 * GA4's `(not set)` source, and nothing else.
 *
 * `(direct)` is deliberately absent — direct traffic is real people typing the
 * name of a store they already know, and it converts. This fires only on GA4
 * explicitly reporting that it could not attribute the session at all, which in
 * the measured window is 4,382 sessions at 2.5% engagement.
 *
 * An ABSENT source (undefined/null/'') is not `(not set)`: it is a caller that
 * does not carry the dimension, which every pre-2026-09-15 GA4 row is. Kept.
 */
const NO_SOURCE_VALUES = new Set(['(not set)']);

/** Lower-cased bare host, `www.` stripped. null when there is nothing usable. */
function normalizeHost(host) {
  if (host === null || host === undefined) return null;
  const h = String(host).trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  if (!h || h.startsWith('(')) return null; // GA4 placeholders: (not set), (direct)
  return h;
}

/** True when a referrer host or GA4 session source is a sweepstakes aggregator. */
export function isSweepstakesReferrer(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  if (SWEEPSTAKES_HOSTS.has(h)) return true;
  return SWEEPSTAKES_TOKENS.test(h);
}

/**
 * The country a dimension actually states, or null when it states nothing.
 * GA4 writes `(not set)` here too, and that is an ABSENCE of evidence rather than
 * evidence of a non-US session — so it is never grounds for exclusion.
 */
function statedCountry(country) {
  if (country === null || country === undefined) return null;
  const c = String(country).trim();
  if (!c || c.startsWith('(')) return null;
  return c;
}

/**
 * Which rung of the ladder a GA4 session row falls out at, or null when it is
 * clean US shoppable traffic.
 *
 * ORDER IS LOAD-BEARING. The rungs are a ladder, not a set of tags: a session can
 * satisfy several (a Singaporean visitor arriving on the giveaway page from
 * contestgirl.com satisfies three) and must be counted on exactly one, or the
 * printed ladder does not sum to the raw total and a reader cannot follow how
 * 17,022 becomes 2,935.
 *
 * PAID TRAFFIC IS NOT EXCLUDED as a class, and that is deliberate. All the
 * Facebook paid traffic in the measured window landed on the giveaway page and is
 * already caught by that rung; excluding paid by source would hide future paid
 * performance, which is the one thing this report exists to measure.
 */
export function sessionExclusion({ country, source, page } = {}, { giveawayPaths = GIVEAWAY_PATHS } = {}) {
  const c = statedCountry(country);
  if (c && c !== US_GA4_COUNTRY) return 'non-us';
  if (NO_SOURCE_VALUES.has(String(source ?? '').trim().toLowerCase())) return 'no-source';
  if (isSweepstakesReferrer(source)) return 'sweepstakes-referrer';
  if (segmentOf(page, { giveawayPaths }) === 'giveaway-lander') return 'giveaway-lander';
  return null;
}

/**
 * The same ladder applied to an ORDER, on the order's own evidence.
 *
 * This half is what keeps the fraction honest. Filtering only sessions would drop
 * non-US traffic from the denominator while keeping every order in the numerator,
 * so CVR would read too HIGH — worse than the defect being fixed, because it
 * points the same way as the GA4 hole this module already refuses to measure over.
 *
 * There is no `no-source` rung here: an order carries no GA4 session source, and
 * inventing a proxy for one would be guessing. An order with an unknown country is
 * KEPT, same rule as the sessions side.
 */
export function orderExclusion(row, { giveawayPaths = GIVEAWAY_PATHS } = {}) {
  const code = statedCountry(row?.country)?.toUpperCase() || null;
  if (code && !US_COUNTRY_CODES.has(code)) return 'non-us';
  if (isSweepstakesReferrer(row?.referrerHost)) return 'sweepstakes-referrer';
  if (segmentOf(row?.landingPath, { giveawayPaths }) === 'giveaway-lander') return 'giveaway-lander';
  return null;
}

/**
 * Reduce a GA4 landing page or a Shopify landing_site path to a comparable path.
 * Returns null for anything unusable, so callers count it rather than bucket it.
 */
export function normalizeLandingPath(p) {
  if (p === null || p === undefined) return null;
  const raw = String(p).trim();
  if (!raw || raw === '(not set)') return null;
  let s = raw.split('?')[0].split('#')[0];
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s || '/';
}

/** Page type, except that the giveaway funnel is broken out on its own. */
export function segmentOf(path, { giveawayPaths = GIVEAWAY_PATHS } = {}) {
  const norm = normalizeLandingPath(path);
  if (norm === null) return null;
  if (isGiveawayPath(norm, { giveawayPaths })) return 'giveaway-lander';
  return pageTypeOf(norm);
}

function emptyBucket() {
  return { sessions: 0, orders: 0, revenue: 0 };
}

/** orders ÷ sessions, or null when there is no denominator to divide by. */
function rateOf(bucket) {
  if (bucket.sessions <= 0) return null;
  return bucket.orders / bucket.sessions;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Join GA4 sessions to Shopify orders by landing-page segment.
 *
 * `segments`, `totals`, `commercial` and `blog` describe CLEAN US SHOPPABLE traffic
 * only — everything the ladder above excluded is gone from them. `rawTotals` is the
 * top of the ladder and `excluded[]` is every rung, so the whole descent is visible
 * without re-running anything. The identities that make the ladder readable:
 *
 *   rawTotals.sessions === totals.sessions + SUM(excluded[].sessions)
 *   rawTotals.revenue  === totals.revenue  + SUM(excluded[].revenue) + noLandingPage.revenue
 *
 * (`unmappedSessions` sits outside both, exactly as it always has — a GA4 landing
 * page that cannot be parsed is not a rung, it is an unusable row.)
 *
 * @param {object} opts
 * @param {Array<{page:string, sessions:number, country?:string, source?:string}>} opts.ga4Rows
 * @param {Array<{landingPath:string|null, total:number, countsAsRevenue:boolean, country?:string, referrerHost?:string}>} opts.orderRows
 *        Records from lib/order-attribution.js attributionRows().
 * @param {Set<string>} [opts.giveawayPaths]
 * @returns {{
 *   segments: Array<{segment:string, sessions:number, orders:number, revenue:number, cvr:number|null, revenuePerSession:number|null}>,
 *   totals: object, rawTotals: object, commercial: object, blog: object,
 *   excluded: Array<{reason:string, sessions:number, orders:number, revenue:number}>,
 *   noLandingPage: {orders:number, revenue:number},
 *   unmappedSessions: number,
 * }}
 */
export function aggregateCvr({ ga4Rows = [], orderRows = [], giveawayPaths = GIVEAWAY_PATHS } = {}) {
  const buckets = new Map();
  const bucket = (seg) => {
    if (!buckets.has(seg)) buckets.set(seg, emptyBucket());
    return buckets.get(seg);
  };

  // Every rung is present even at zero. A rung that disappears when it is empty is
  // indistinguishable from a rung that was never checked, and the ladder is the
  // whole point of this report.
  const excluded = new Map(EXCLUSION_REASONS.map((reason) => [reason, emptyBucket()]));
  const exclude = (reason) => excluded.get(reason);

  let unmappedSessions = 0;
  for (const row of ga4Rows) {
    const seg = segmentOf(row?.page, { giveawayPaths });
    const sessions = Number(row?.sessions) || 0;
    if (seg === null) { unmappedSessions += sessions; continue; }
    const reason = sessionExclusion(
      { country: row?.country, source: row?.source, page: row?.page },
      { giveawayPaths },
    );
    if (reason) { exclude(reason).sessions += sessions; continue; }
    bucket(seg).sessions += sessions;
  }

  // Orders with no landing_site are subscription renewals and app-channel orders.
  // They had no web session, so giving them a segment would invent a rate with an
  // empty denominator. They are reported separately so revenue still reconciles.
  //
  // Checked BEFORE the ladder on purpose: an order with no landing page has no
  // session anywhere in the ladder, so it cannot honestly be attributed to a rung.
  const noLandingPage = { orders: 0, revenue: 0 };
  for (const row of orderRows) {
    if (!row?.countsAsRevenue) continue;
    const total = Number(row?.total) || 0;
    const seg = segmentOf(row?.landingPath, { giveawayPaths });
    if (seg === null) {
      noLandingPage.orders += 1;
      noLandingPage.revenue = round2(noLandingPage.revenue + total);
      continue;
    }
    const reason = orderExclusion(row, { giveawayPaths });
    const b = reason ? exclude(reason) : bucket(seg);
    b.orders += 1;
    b.revenue = round2(b.revenue + total);
  }

  const segments = [...buckets.entries()]
    .map(([segment, b]) => ({
      segment,
      sessions: b.sessions,
      orders: b.orders,
      revenue: b.revenue,
      cvr: rateOf(b),
      revenuePerSession: b.sessions > 0 ? b.revenue / b.sessions : null,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.orders - a.orders);

  const rollup = (names) => {
    const acc = emptyBucket();
    for (const n of names) {
      const b = buckets.get(n);
      if (!b) continue;
      acc.sessions += b.sessions;
      acc.orders += b.orders;
      acc.revenue = round2(acc.revenue + b.revenue);
    }
    return { ...acc, cvr: rateOf(acc) };
  };

  const totals = rollup([...buckets.keys()]);

  const excludedRows = EXCLUSION_REASONS.map((reason) => ({ reason, ...excluded.get(reason) }));

  // The top of the ladder: everything before a single rung was applied, plus the
  // orders that never had a session at all, so the revenue identity closes.
  const rawTotals = (() => {
    const acc = { ...totals };
    for (const e of excludedRows) {
      acc.sessions += e.sessions;
      acc.orders += e.orders;
      acc.revenue = round2(acc.revenue + e.revenue);
    }
    acc.orders += noLandingPage.orders;
    acc.revenue = round2(acc.revenue + noLandingPage.revenue);
    return { ...acc, cvr: rateOf(acc) };
  })();

  return {
    segments,
    totals,
    rawTotals,
    excluded: excludedRows,
    commercial: rollup(COMMERCIAL_SEGMENTS),
    blog: rollup(['blog']),
    noLandingPage,
    unmappedSessions,
  };
}

/**
 * Throw unless the window starts strictly after the GA4 outage.
 * Fails loud rather than quietly reporting an inflated rate.
 */
export function assertGa4WindowClean(startDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) {
    throw new Error(`commercial-cvr: start date must be YYYY-MM-DD, got: ${startDate}`);
  }
  if (startDate <= GA4_HOLE_END) {
    throw new Error(
      `commercial-cvr: window starts ${startDate}, on or before the GA4 data hole ending ${GA4_HOLE_END}. ` +
      `Sessions are missing there but orders are not, so CVR would read too HIGH. Start after ${GA4_HOLE_END}.`
    );
  }
}

/**
 * Maximum you can pay per session (≈ per click) and still break even, given a
 * conversion rate and the offer's contribution margin.
 *
 * This is the whole paid-media question in one line: compare it to a real CPC.
 */
export function breakevenCostPerSession(cvr, contributionMargin) {
  if (cvr === null || !Number.isFinite(cvr) || cvr <= 0) return null;
  if (!Number.isFinite(contributionMargin) || contributionMargin <= 0) return null;
  return cvr * contributionMargin;
}

/** The conversion rate an offer needs to break even at a given cost per click. */
export function requiredCvr(costPerSession, contributionMargin) {
  if (!Number.isFinite(costPerSession) || costPerSession <= 0) return null;
  if (!Number.isFinite(contributionMargin) || contributionMargin <= 0) return null;
  return costPerSession / contributionMargin;
}

/**
 * The two offers a break-even CPC is quoted against.
 *
 * These are matched by ROSTER TITLE, not by handle or by a copied number: the
 * contributions used to be hand-transcribed into `scripts/commercial-page-cvr.mjs`
 * and both went stale. The Coconut Reset sat at "$119 / $47" long after the
 * roster repriced it to $121 with a $78.56 contribution, and the Sensitive Skin
 * Set at $25 against $27.95. A break-even CPC computed from a contribution 40%
 * too low says paid traffic is unaffordable when it is not — the exact decision
 * this report exists to inform.
 */
export const HERO_OFFER_TITLES = Object.freeze([
  'Sensitive Skin Moisturizing Set',
  'The 90-Day Coconut Reset',
]);

/**
 * Pick the hero offers out of the rows `bundle-economics` computes.
 *
 * Throws on a title the roster does not carry. Dropping it silently would print
 * the break-even table with a column missing, which reads like the offer is
 * unaffordable rather than absent — and a roster rename is exactly the event
 * that would cause it.
 *
 * @param {{name:string, price:number, contrib:number}[]} rows
 * @param {readonly string[]} [titles]
 * @returns {{label:string, contribution:number}[]}
 */
export function heroOffers(rows, titles = HERO_OFFER_TITLES) {
  return titles.map((t) => {
    const r = rows.find((x) => x.name === t);
    if (!r) throw new Error(`hero offer is not in the economics roster: ${t}`);
    return { label: `${r.name} ($${r.price})`, contribution: r.contrib };
  });
}
