// lib/cluster-hold.js
//
// "If it doesn't drive revenue, we put it on hold." — Sean, verbatim.
//
// ON HOLD MEANS: stop spending unattended LLM/refresh cycles on a cluster that
// has had a fair shot at traffic and returned $0.
//
// ON HOLD DOES **NOT** MEAN: unpublish, delete, redirect, deindex, or drop from
// a sitemap. These are live, indexed pages; they stay live and keep whatever
// traffic they have. Nothing in this module or its callers touches publish
// state — a held page is a page we stop *paying* for, not a page we remove.
//
// WHY THIS EXISTS: on 2026-08-21 a single $0 cluster consumed 11 of 15 indexing
// "critical" slots and triggered 11 content-quality refreshes, each a chain of
// paid LLM calls, on a cluster that has never produced a dollar.
//
// NO CLUSTER IS NAMED HERE. The held set is derived from measured revenue, so
// the rule generalises to whatever goes to $0 next — and RELEASES a cluster
// automatically the moment it earns a dollar. A hardcoded blocklist would do
// neither.
//
// TWO SOURCES MUST AGREE. That rule survives the 2026-08-23 migration to
// product-level attribution unchanged — but the two sources swapped roles, and
// the third one was retired. Read this before touching either side.
//
// WHAT THE RULE PROTECTS. Held on one source alone, this rule paused the `soap`
// cluster — which sells $324.85 / 90d, 13% of all revenue and second only to
// lotion. seo-impact's entry-page attribution filed $62.40 of that under `hand
// soap` and showed `soap` at $0, and the rule read the artifact as a verdict.
// The safety property is therefore precise: NO SINGLE MEASUREMENT PIPELINE MAY
// CONDEMN A CATEGORY ALONE. Everything below exists to keep that true.
//
// THE TWO SOURCES, AFTER THE SWAP:
//
//              PRIMARY (source A)                 CROSS-CHECK (source B)
//   question   what did this CATEGORY SELL?       what did its PAGES EARN?
//   data       raw order LINE ITEMS               raw order TOTALS
//   join key   product title → cluster            landing-page URL → cluster
//   channels   all                                organic search only
//   window     90 days                            90 days
//   applied by classifyClusters (cluster-         corroborateClusters (here)
//              revenue.js)
//
//   A cluster is `proven_dud` — and therefore held — only when A says $0 AND B
//   says $0, on enough content exposure and in a window big enough to judge.
//
// WHY THAT IS STILL TWO SOURCES AND NOT ONE NUMBER TWICE. The independence that
// caught the soap bug was never "two different databases" — both sides always
// read Shopify orders. It was the JOIN KEY: the same $62.40 order joined by
// product title landed in `soap` and joined by landing-page URL landed in `hand
// soap`, and the contradiction is what stopped the hold. A and B still differ on
// exactly that axis, so the defect class that produced the incident is still
// detectable.
//
// WHY `topProducts[]` WAS RETIRED AS A SOURCE. `data/snapshots/shopify/*.json`
// `topProducts[]` answers the SAME question as A (what the category sold) by the
// SAME join key (product title) — it is a copy of A, capped by
// `agents/shopify-collector` at the top 5 products per day, and demonstrably
// wrong because of the cap: it put toothpaste at $39.00/90d where the raw line
// items say $71.50. Keeping it would have given the appearance of three sources
// while deleting the one axis of real independence. A capped copy of the primary
// is not corroboration.
//
// WHY B IS NOT REDUNDANT, CONCRETELY — MEASURED, NOT ARGUED. Take the incident
// this rule exists for and run it on the new basis: something breaks the
// product-title join and A reads `soap` at $0. Over the 90 days to 2026-08-21
// soap's PAGES earned $110.49 of organic revenue, so B contradicts A, the hold
// is blocked and the contradiction is reported. B would catch the 2026-08-19
// defect today, at soap's real 227 clicks — a bar the old 400-click rule could
// not even reach.
//
// A and B can also disagree for a reason that is not a defect at all: a
// category's pages can earn while its products sell nothing, which is a cluster
// with no SKU behind it. `coconut oil` is the shape — RSC ships no coconut-oil
// product, so A is structurally $0 forever. Note it is NOT currently an example
// of B firing: measured over the same window its pages earned $0.00 too, and it
// is spared only by the click precondition (11 clicks). Do not repeat the
// earlier version of this paragraph, which asserted its posts "do send readers
// to lotion" — entry-page attribution says otherwise, and the whole point of
// this file is not to state a number nobody measured. What stays true is the
// diagnosis: "there is nothing to sell here" is not "this content failed", and
// only B can tell them apart.
//
// WHAT "ABSENT FROM THE ROLLUP" MEANS, because the whole rule rests on it. A
// cluster with no row in `clusters_product_wide[]` reads $0 on BOTH sources and
// can therefore be held. That is correct, and it is correct for a specific
// reason: each rollup covers EVERY order in the window, so a cluster it never
// mentions is one that took no line item and hosted no landing page — a measured
// zero, not a missing measurement. "Missing measurement" is a whole-array
// property (no rows at all, or no entry-page column at all), and it is handled at
// that granularity in `readWideSources` and in `classifyClusters`'s refusal of an
// empty or all-zero product map.
//
// THE HONEST LIMITATION THAT FOLLOWS. Source B is built from
// `shopifyRevenueByPage`, which drops any order with no `landingPath` — a
// subscription renewal, a direct cart. Those orders earned money for no landing
// page, which is the right answer to B's question, but it means B UNDER-REPORTS
// for clusters whose buyers arrive that way. B failing to block a hold it morally
// should have blocked is therefore possible; B wrongly CAUSING one is not, since
// it can only ever add a zero to a verdict A already reached. Two sources reduce
// false condemnations; they do not eliminate them, and this file should not claim
// otherwise.
//
// IS "CORROBORATION" STILL THE RIGHT WORD? Yes, but for the VERDICT rather than
// the MEASUREMENT. Under the old design both sources measured the same quantity
// two ways, so B corroborated A's number. Now they measure different quantities,
// and B corroborates the CONCLUSION — "this category earns nothing" — by
// answering a second question whose answer would also have to be zero for the
// conclusion to hold. Where a source can only ever block a hold and never cause
// one, "cross-check" is the honest label, and the reason strings say so.
//
// If they disagree, the cluster is NOT held and the disagreement is reported
// loudly: it means either attribution is broken for that cluster or its pages
// are top-of-funnel for someone else's category. Both are findings worth
// surfacing in their own right, not details to swallow.
//
// The two vocabularies meet through `lib/keyword-index/cluster.js`'s ordered
// `assignCluster`, applied to BOTH sides — and its first-match ordering (soap
// before lotion) is the only reason "Moisturizing Coconut Soap" counts as soap.
//
// The classification itself is not re-implemented: `classifyClusters` already
// answers earning / proven_dud / unproven, and a second copy of those thresholds
// would drift away from the one the queue and the strategist hold on.
//
// THE AOV FLOOR IS GONE, deliberately. The old rule asked whether measured
// revenue cleared "one average order in the window", because `topProducts[]` was
// capped and noisy and a few dollars of noise should not have blocked a hold.
// Both sources are now exact — line items reconcile to `subtotal_price` to the
// cent, order totals are the orders themselves — so there is no noise left for a
// floor to absorb, and a floor would instead be a materiality judgement that
// `classifyClusters` explicitly does not make ("any amount counts"). The two
// steps now use the same test, `> $0`, for the first time. The materiality
// notion did not vanish: it was restated as a RATE and is what the thresholds in
// `lib/cluster-revenue.js` are derived from.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyClusters, clusterForText, provenDuds, JUDGING_WINDOW_DAYS, MIN_WINDOW_ORDERS,
} from './cluster-revenue.js';
import { assignCluster } from './keyword-index/cluster.js';
import {
  SEO_IMPACT_RELPATH, SEO_IMPACT_MAX_AGE_DAYS, freshnessOfReport, staleNote, todayPT,
} from './seo-impact-freshness.js';

/** The operator's escape hatch, spelled the same way by every agent. */
export const HOLD_FLAG = '--include-held';

/**
 * The one report every agent holds on. One path, so nobody holds on a different
 * truth — now owned by `lib/seo-impact-freshness.js` alongside the one staleness
 * policy, and re-exported here so existing importers are unchanged.
 */
export { SEO_IMPACT_RELPATH, SEO_IMPACT_MAX_AGE_DAYS };

/**
 * The window both sources are read over, in days.
 *
 * Owned by `lib/cluster-revenue.js`, where the derivation lives (at a floor of
 * one average order per 28 days, a window must span ≥84 days before a
 * genuinely-selling category recording zero drops under 5%). Re-exported under
 * its historical name so existing importers are unchanged.
 */
export const WIDE_WINDOW_DAYS = JUDGING_WINDOW_DAYS;

function defaultReadJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * The single vocabulary both sources are compared in.
 *
 * Applied to seo-impact's cluster names AND to Shopify product titles, so the
 * report's `soap`/`hand soap` split and a product called "Foam Soap Refill |
 * 32oz" land in the same bucket. Returns `'unclustered'` when a name maps to
 * nothing, which is treated as "cannot corroborate", never as "earns zero".
 */
export function clusterFamily(name) {
  return assignCluster(name);
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Fold a cluster → dollars map through the shared family taxonomy.
 *
 * Applied to source B before it is compared, for the same reason source A is
 * folded in `classifyClusters`: the two sides must be in one vocabulary or the
 * comparison is meaningless. Returns null for a null input — "not measured" and
 * "measured as nothing" are different answers and must not collapse.
 */
function foldByFamily(byCluster) {
  if (!byCluster) return null;
  const out = {};
  for (const [raw, value] of Object.entries(byCluster)) {
    const fam = clusterFamily(raw);
    if (fam === 'unclustered') continue;
    out[fam] = round2((out[fam] || 0) + (Number(value) || 0));
  }
  return out;
}

/**
 * Apply the CROSS-CHECK (source B) to every cluster in the classification.
 *
 * Source B is what the category's PAGES earned — entry-page-credited,
 * organic-search-only revenue over the same 90-day judging window, keyed on the
 * landing page's URL rather than on a product title. It can only ever BLOCK a
 * hold; it can never cause one.
 *
 * @param {Record<string,{status:string,productRevenue:number|null}>} classified  from classifyClusters
 * @param {{entryPageRevenue?: Record<string,number>|null}} [opts]
 *        `entryPageRevenue` is cluster → source-B dollars, or null when the
 *        report carries no wide entry-page reading at all. Null means NOT
 *        MEASURED, and nothing may be held on an unmeasured cross-check.
 * @returns {Record<string,{verdict:'held'|'disagreement'|'uncorroborated'|'earning'|'unproven',
 *                          family:string, reason:string|null, productRevenue:number,
 *                          entryPageRevenue:number|null}>}
 */
export function corroborateClusters(classified, { entryPageRevenue = null } = {}) {
  const out = {};
  const pagesEarned = foldByFamily(entryPageRevenue);

  for (const [cluster, stats] of Object.entries(classified || {})) {
    const family = clusterFamily(cluster);
    // Reported for EVERY cluster, not just the duds — an operator reading the
    // table needs to see sold-vs-earned on the earning rows too, since that
    // comparison is what exposes an attribution split. The figure is per FAMILY,
    // so sibling clusters legitimately repeat it.
    const earned = pagesEarned && family !== 'unclustered' ? (pagesEarned[family] || 0) : null;
    const sold = round2(Number(stats.productRevenue) || 0);

    if (stats.status !== 'proven_dud') {
      out[cluster] = {
        verdict: stats.status, family, reason: null, productRevenue: sold, entryPageRevenue: earned,
      };
      continue;
    }

    if (family === 'unclustered') {
      out[cluster] = {
        verdict: 'uncorroborated', family, productRevenue: sold, entryPageRevenue: null,
        reason: `"${cluster}" could not be mapped to a product family, so its $0 cannot be cross-checked `
          + 'against what its pages earned — not held',
      };
      continue;
    }

    if (pagesEarned === null) {
      out[cluster] = {
        verdict: 'uncorroborated', family, productRevenue: sold, entryPageRevenue: null,
        reason: 'the report carries no entry-page revenue for the judging window, so the second source '
          + 'is missing entirely — not held',
      };
      continue;
    }

    if (earned > 0) {
      out[cluster] = {
        verdict: 'disagreement', family, productRevenue: sold, entryPageRevenue: earned,
        reason: `SOURCES DISAGREE — the "${family}" products sold $0.00 over the judging window, but pages `
          + `in that cluster earned $${round2(earned)} of organic revenue over the same window. NOT held. `
          + 'Either attribution is broken for this cluster, or these pages sell somebody else\'s category '
          + '(a cluster with no SKU behind it does exactly that) — both are worth fixing, neither is a dud.',
      };
      continue;
    }

    out[cluster] = {
      verdict: 'held', family, productRevenue: sold, entryPageRevenue: earned,
      reason: 'cross-checked: the products sold $0.00 AND the cluster\'s pages earned $0.00 of organic '
        + 'revenue over the judging window — both sources agree',
    };
  }
  return out;
}

/**
 * Why NO cluster could have been judged this run, or null when the gate was
 * genuinely armed.
 *
 * A DISARMED GATE MUST NOT LOOK LIKE A CLEAN RUN. Every fail-open branch in this
 * module and in `classifyClusters` yields the same visible outcome — nothing
 * held, no banner — as a report on which every category simply earns. The
 * freshness section of CLAUDE.md calls that shape "a quiet loss of capability",
 * and until 2026-08-23 a report carrying `clusters_product_wide: []` produced it
 * silently while `available` still read true. It is reported now.
 *
 * The product side is derived from the CLASSIFICATION rather than from the raw
 * input, because `classifyClusters` has its own reasons to declare the reading
 * unusable (an all-zero map) that a caller inspecting `productRevenue` would
 * miss.
 */
function disarmedReason(classified, { entryPageRevenue, windowOrders, minWindowOrders }) {
  const rows = Object.values(classified || {});
  if (!rows.length) return null;
  if (!rows.some((v) => v.productRevenue !== null)) {
    return 'no product-revenue reading for the judging window (the report carries no usable '
      + '`clusters_product_wide[]`) — no cluster can be judged this run';
  }
  if (windowOrders === null || windowOrders === undefined) {
    return 'the judging window\'s order count is missing from the report — no cluster can be judged this run';
  }
  if (Number(windowOrders) < minWindowOrders) {
    return `the judging window recorded only ${windowOrders} order(s), below the ${minWindowOrders} `
      + 'needed before any $0 means anything — no cluster can be judged this run';
  }
  if (entryPageRevenue === null) {
    return 'the report carries no entry-page revenue for the judging window, so the cross-check is '
      + 'missing entirely — nothing can be held this run';
  }
  return null;
}

/**
 * Build a hold context from an already-classified cluster map.
 *
 * @param {Record<string,{status:string,revenue:number,clicks:number,pages:number}>} classified
 * @returns {{classified:object, held:Array, heldSet:Set<string>, available:boolean,
 *            generatedAt:string|null, source:string|null}}
 */
export function buildClusterHold(classified, {
  available = true, generatedAt = null, source = null,
  entryPageRevenue = null, judgingWindow = null, windowOrders = null,
  stale = false, freshness = null, minWindowOrders = MIN_WINDOW_ORDERS,
} = {}) {
  const corroborated = corroborateClusters(classified, { entryPageRevenue });
  const duds = provenDuds(classified);
  const disarmed = disarmedReason(classified, { entryPageRevenue, windowOrders, minWindowOrders });

  const held = []; const disagreements = []; const uncorroborated = [];
  for (const dud of duds) {
    const c = corroborated[dud.cluster] || {};
    const row = {
      ...dud,
      family: c.family,
      productRevenue: c.productRevenue || 0,
      entryPageRevenue: c.entryPageRevenue ?? null,
      corroboration: c.reason,
    };
    if (c.verdict === 'held') held.push(row);
    else if (c.verdict === 'disagreement') disagreements.push(row);
    else uncorroborated.push(row);
  }

  return {
    classified: classified || {},
    corroborated,
    // What the two sources were read over, so a banner or a report can say it
    // rather than assume the reader knows the gate is not on the 28-day window.
    judgingWindow,
    windowOrders,
    // Why nothing COULD be judged, when that is the case. Never inferred from
    // `held.length === 0` by a caller — a clean report and a disarmed gate are
    // both empty, and telling them apart is the whole point of this field.
    disarmed,
    // Only clusters BOTH sources agree earn nothing. A $0-attributed cluster
    // that really sells is a disagreement, not a hold.
    held,
    heldSet: new Set(held.map((h) => h.cluster)),
    disagreements,
    uncorroborated,
    available,
    // A stale report is `available: false` like an absent one — the two differ
    // only in what the banner says, never in what may be blocked or deleted.
    stale,
    freshness,
    generatedAt,
    source,
  };
}

/**
 * Read the revenue report and build the hold context.
 *
 * `readJson` is injectable so this is testable without a fixture on disk, and so
 * an agent that already has the report in hand does not read it twice.
 *
 * A MISSING report holds NOTHING. Pausing work on an absent measurement would
 * turn a stale cron box into a fleet-wide freeze, which is the opposite of the
 * Prime Directive. Callers print `holdBanner()` so the blindness is visible.
 *
 * A STALE REPORT IS TREATED EXACTLY LIKE A MISSING ONE, and this is the crux of
 * the whole freshness change. Everything reached from here either blocks work
 * (`calendar-runner` refuses to draft, `content-strategist` silently drops LLM
 * proposals and clears calendar items, `queue-autoapply` dismisses collection
 * gaps) or DELETES it (`lib/brief-triage.js` → `scripts/triage-orphan-briefs.mjs
 * --drop-non-earning --apply` calls `unlinkSync` on paid-for research). None of
 * those are reversible, and none of them may fire on a measurement nobody has
 * refreshed in a week. So a stale report yields `available: false` and an EMPTY
 * classification: every cluster reads `unproven`, nothing is held, nothing is
 * blocked, nothing is deleted. `stale: true` and the freshness result are kept
 * so `holdBanner()` can say which failure this is and how old the report got.
 *
 * That is the same fail-open shape `classifyClusters` already has for a missing
 * product-revenue reading (below) — one more input the gate refuses to guess at,
 * not a second mechanism beside it.
 *
 * BOTH SOURCES NOW COME OUT OF THE SAME FILE, and that is not the same thing as
 * one source. They are two different fields, computed by two different rollups,
 * over two different join keys — see the header. What it does mean is that a
 * report written before `clusters_product_wide` existed carries NEITHER, so the
 * gate goes quiet until `agents/seo-impact` next runs: `readWideSources` returns
 * nulls, `classifyClusters` can call nothing a dud, and the banner says so. That
 * is the correct behaviour for a deploy — the alternative is condemning
 * categories on a field the running report does not have.
 *
 * `today` is injectable for the same reason `readJson` is: so the freshness
 * boundary is testable without touching the clock.
 */
export function loadClusterHold({
  root = process.cwd(), readJson = defaultReadJson, today = todayPT(),
} = {}) {
  const source = join(root, SEO_IMPACT_RELPATH);
  const impact = readJson(source);
  // Freshness comes from the report OBJECT, not a second read of the path — a
  // re-read would bypass the injected `readJson` and make this untestable
  // without a fixture on disk.
  const freshness = freshnessOfReport(impact, { today });
  const stale = freshness.status === 'stale';
  const usable = !!impact && !stale;

  const { productRevenue, entryPageRevenue, judgingWindow, windowOrders } = usable
    ? readWideSources(impact)
    : { productRevenue: null, entryPageRevenue: null, judgingWindow: null, windowOrders: null };

  // Neither source is optional garnish. Without the product reading there is no
  // verdict to make; without the judging window's order count there is no
  // denominator, and a broken order pull would otherwise read as every category
  // dying at once. `classifyClusters` refuses to call anything a dud without both.
  return buildClusterHold(classifyClusters(usable ? (impact.clusters || []) : [], {
    productRevenue, windowOrders,
  }), {
    available: usable,
    stale,
    freshness,
    generatedAt: impact?.generated_at || null,
    source,
    entryPageRevenue,
    judgingWindow,
    windowOrders,
  });
}

/**
 * Pull both sources out of the report's 90-day block.
 *
 * `clusters_product_wide` rows carry `product_revenue_all_channels` (source A —
 * what the category sold) and `entry_page_organic_revenue` (source B — what its
 * pages earned) for the same window, so one read serves both. Returns nulls
 * rather than empty maps when the block is absent: "not measured" and "measured
 * as zero" must never collapse, because the second is a verdict and the first is
 * a missing input.
 *
 * Exported for the report-shape tests; production reaches it via loadClusterHold.
 */
export function readWideSources(impact) {
  const rows = Array.isArray(impact?.clusters_product_wide) ? impact.clusters_product_wide : null;
  const meta = impact?.cluster_product_meta || null;
  const window = { judgingWindow: meta?.wide_window || null, windowOrders: meta?.wide_orders_all_channels ?? null };
  if (!rows || !rows.length) return { productRevenue: null, entryPageRevenue: null, ...window };

  // SOURCE B HAS ITS OWN PRESENCE CHECK, and it is not paranoia — there is a real
  // report shape that carries A and not B: `clusters_product_wide` shipped one
  // change before the entry-page column was added to it. Reading a missing field
  // as `|| 0` would make every cluster's cross-check read "its pages earned
  // nothing", which is the direction that CREATES holds. Absent means absent.
  const hasEntryPage = rows.some((r) => r && Object.hasOwn(r, 'entry_page_organic_revenue'));

  const productRevenue = {}; const entryPageRevenue = hasEntryPage ? {} : null;
  for (const r of rows) {
    if (!r?.cluster) continue;
    productRevenue[r.cluster] = Number(r.product_revenue_all_channels) || 0;
    // Once the column exists, a row missing it contributes 0 rather than
    // undefined: the rows are unioned across both rollups, so an absent key
    // genuinely means that cluster's pages earned nothing.
    if (entryPageRevenue) entryPageRevenue[r.cluster] = Number(r.entry_page_organic_revenue) || 0;
  }
  return { productRevenue, entryPageRevenue, ...window };
}

/**
 * The classification, with every UNCORROBORATED `proven_dud` downgraded to
 * `unproven`. This is what anything that BLOCKS or DELETES work must read.
 *
 * `classifyClusters` answers one question — did this category's PRODUCTS sell
 * anything over the judging window? — from one source. That verdict is enough to
 * pause unattended spend (this module's original job), and it is NOT enough to
 * drop an LLM's proposal, defer a calendar item by 30 days, or archive a paid-for
 * brief. Those three consumers were reading the raw classification, so on
 * 2026-08-22 the `soap` cluster — with a paid giveaway campaign live — was
 * silently blocked from content and had its briefs marked for deletion, on an
 * attribution artifact.
 *
 * A deletion path must be at least as evidence-hungry as a spend pause, so it
 * gets the same two-source rule: the products sold $0 AND the cluster's pages
 * earned $0 of organic revenue over the same window. A disagreement, a cluster
 * that maps to no product family, and a report with no wide block at all each
 * downgrade to `unproven` — nothing is blocked on evidence we do not have.
 *
 * @param {object} hold  from loadClusterHold/buildClusterHold
 * @returns {Record<string,object>} same shape as classifyClusters
 */
export function corroboratedClassification(hold) {
  const out = {};
  for (const [cluster, stats] of Object.entries(hold?.classified || {})) {
    if (stats.status !== 'proven_dud' || hold?.heldSet?.has(cluster)) {
      out[cluster] = { ...stats, corroboration: hold?.corroborated?.[cluster]?.reason || null };
      continue;
    }
    const c = hold?.corroborated?.[cluster] || {};
    out[cluster] = {
      ...stats,
      status: 'unproven',
      evidence: c.reason
        || 'attributed $0 could not be corroborated against real Shopify orders — not treated as a dud',
      corroboration: c.reason || null,
      uncorroboratedDud: true,
    };
  }
  return out;
}

/**
 * Which cluster a piece of work belongs to.
 *
 * Ordered most-precise-first: the target keyword is what seo-impact attributes
 * revenue on, the slug is what survives when no keyword was ever recorded (the
 * legacy corpus), and title/url are last-resort. Everything runs through
 * `clusterForText` so this agrees with the taxonomy the revenue numbers were
 * computed under.
 */
export function clusterForItem(item) {
  if (!item) return null;
  const fields = [item.keyword, item.target_keyword, item.slug, item.title, item.url, item.category];
  for (const f of fields) {
    const c = clusterForText(f);
    if (c) return c;
  }
  return null;
}

/**
 * The sentence an agent logs and puts in the digest. Says what a hold is and is not.
 *
 * It quotes the PRODUCT figure, because that is what the verdict was made on.
 * Quoting `revenue` (the entry-page alias) here would print the number the gate
 * no longer judges by, next to a decision made on a different one — which is the
 * exact confusion this migration exists to end.
 */
export function holdReason(cluster, stats = {}) {
  const sold = Number(stats.productRevenue) || 0;
  const clicks = Number(stats.clicks) || 0;
  const pages = Number(stats.pages) || 0;
  return `the "${cluster}" cluster is ON HOLD — its products sold $${sold.toFixed(2)} over the judging `
    + `window, behind ${clicks} clicks across ${pages} pages. `
    + `Unattended refresh/LLM spend is paused until it earns (Prime Directive). `
    + `The page stays live and indexed — nothing is unpublished, deleted or redirected. `
    + `Re-run with ${HOLD_FLAG} to work on it anyway.`;
}

/**
 * Decide one item.
 *
 * @returns {{cluster:string|null, onHold:boolean, skip:boolean, overridden?:boolean,
 *            reason:string|null, stats:object|null}}
 *
 * `onHold` and `skip` are deliberately separate: with the override the cluster
 * is still held, we are just choosing to spend on it anyway, and the run should
 * still say so.
 */
export function holdDecision(item, hold, { includeHeld = false } = {}) {
  const cluster = clusterForItem(item);
  const stats = (cluster && hold?.classified?.[cluster]) || null;
  const onHold = !!(cluster && hold?.heldSet?.has(cluster));
  if (!onHold) return { cluster, onHold: false, skip: false, reason: null, stats };
  const reason = holdReason(cluster, stats || {});
  return includeHeld
    ? { cluster, onHold: true, skip: false, overridden: true, reason, stats }
    : { cluster, onHold: true, skip: true, reason, stats };
}

/**
 * Split a pick list into what runs and what is held.
 *
 * Held items are RETURNED, never dropped — the whole point is that a held
 * cluster is visible in the run summary rather than mysteriously quiet.
 *
 * @param {Array} items
 * @param {object} hold  from loadClusterHold/buildClusterHold
 * @param {{includeHeld?:boolean, describe?:(item:any)=>object}} opts
 *        `describe` maps an item to {slug,keyword,title,url}; the default treats
 *        the item as already having those fields.
 * @returns {{kept:Array, held:Array<{item:any,slug:string,cluster:string,reason:string}>, overridden:Array}}
 */
export function partitionHeld(items, hold, { includeHeld = false, describe = (i) => i } = {}) {
  const kept = []; const held = []; const overridden = [];
  for (const item of items || []) {
    const facts = describe(item) || {};
    const d = holdDecision(facts, hold, { includeHeld });
    const record = { item, slug: facts.slug || null, cluster: d.cluster, reason: d.reason };
    if (d.skip) { held.push(record); continue; }
    if (d.onHold) overridden.push(record);
    kept.push(item);
  }
  return { kept, held, overridden };
}

/**
 * One entry per held POST.
 *
 * A pick list can legitimately name the same slug several times — a post that is
 * a flop, a quick win and a low-CTR query all at once appears in three of
 * performance-engine's four pickers. Reporting it three times inflates the count
 * an operator uses to judge how much a hold is actually withholding. Entries
 * with no slug are never collapsed; they are distinct by construction.
 */
export function dedupeHeld(held) {
  const seen = new Set(); const out = [];
  for (const h of held || []) {
    if (h?.slug) {
      if (seen.has(h.slug)) continue;
      seen.add(h.slug);
    }
    out.push(h);
  }
  return out;
}

/** ", 11 held" for a notify subject; empty string on a clean run. */
export function holdSummaryFragment(held) {
  const n = dedupeHeld(held).length;
  return n ? `, ${n} held` : '';
}

/**
 * Digest/console lines for the held items. Empty array when nothing was held,
 * so a normal run gains no noise.
 *
 * The per-slug list is capped: a real first run held 20 posts, and twenty lines
 * of the same explanation in the 5 AM digest is how a section becomes one
 * nobody reads. The count and the per-cluster breakdown are always complete —
 * `npm run cluster-holds` is where the full picture lives.
 */
export function renderHoldLines(rawHeld, { max = 10 } = {}) {
  const held = dedupeHeld(rawHeld);
  if (!held.length) return [];
  const byCluster = new Map();
  for (const h of held) byCluster.set(h.cluster, (byCluster.get(h.cluster) || 0) + 1);
  const summary = [...byCluster.entries()].map(([c, n]) => `${c} (${n})`).join(', ');
  const shown = held.slice(0, max);
  return [
    `HELD ${held.length} item(s) in $0 cluster(s): ${summary}.`,
    `Every one of those pages is still live and indexed — only the unattended spend is paused (Prime Directive). Re-run with ${HOLD_FLAG} to include them.`,
    ...shown.map((h) => `  [held:${h.cluster}] ${h.slug || '(unnamed item)'}`),
    ...(held.length > shown.length ? [`  … and ${held.length - shown.length} more (npm run cluster-holds)`] : []),
  ];
}

/**
 * Compact digest lines for an attribution disagreement.
 *
 * The console banner only reaches whoever is watching a terminal. These agents
 * run unattended at 3 and 8 AM, so the 5 AM digest is the ONLY channel a
 * disagreement can speak through — and a disagreement is a live defect in the
 * revenue report every prioritiser in the fleet reads, not a footnote.
 *
 * Deliberately one line per cluster: this appears in each gated agent's digest
 * row, so it must stay small enough that repetition is tolerable, and it
 * disappears entirely the moment attribution is fixed.
 */
export function renderDisagreementLines(hold) {
  if (!hold?.disagreements?.length) return [];
  return [
    `⚠ SOURCES DISAGREE — ${hold.disagreements.length} cluster(s) whose products sold $0 have pages that earn; NOT held:`,
    ...hold.disagreements.map((d) => `  ${d.cluster}: "${d.family}" products sold $0.00, but its pages earned `
      + `$${round2(d.entryPageRevenue)} of organic revenue over the same window`),
  ];
}

/**
 * The startup banner: what is currently held, and on what evidence. Printed by
 * every gated agent so a hold is never invisible.
 *
 * Returns '' when nothing is held AND the report was readable — the only silent
 * case, and the normal one.
 */
export function holdBanner(hold) {
  if (!hold) return '';
  // Stale and absent are different diagnoses with the same consequence. Saying
  // "missing" about a file that is right there sends the reader looking for the
  // wrong problem — the producer has stopped, the file has not gone anywhere.
  if (hold.stale) {
    return `  ⚠ ${staleNote(hold.freshness)} The $0-cluster hold cannot fire this run. `
      + 'Nothing is paused, blocked or deleted on a measurement this old.';
  }
  if (!hold.available) {
    return `  ⚠ ${SEO_IMPACT_RELPATH} is missing — the $0-cluster hold cannot fire this run. `
      + 'Nothing is paused on a guess; run agents/seo-impact to restore it.';
  }

  const lines = [];
  const win = hold.judgingWindow
    ? `${hold.judgingWindow.start} → ${hold.judgingWindow.end}`
    : `${WIDE_WINDOW_DAYS}d`;

  // A DISARMED GATE IS NOT A CLEAN RUN, and it used to render identically to
  // one: report present, `available: true`, nothing held, banner empty. That is
  // the same invisible loss of capability the staleness rule exists to make
  // loud, so it gets a line of its own even though nothing is wrong with the
  // fleet — the fix is to look at why the report is missing an input.
  if (hold.disarmed) {
    lines.push(`  ⚠ The $0-cluster gate is OFF this run: ${hold.disarmed}.`);
    lines.push('      Nothing is paused, blocked or deleted. Every agent runs its full pick list.');
  }

  if (hold.held.length) {
    lines.push(`  ${hold.held.length} cluster(s) ON HOLD (report ${hold.generatedAt || 'date unknown'}, judged over ${win}`
      + `${hold.windowOrders == null ? '' : `, ${hold.windowOrders} orders`}) — pages stay live, spend is paused:`);
    for (const h of hold.held) {
      lines.push(`      ${h.cluster}: products sold $${round2(h.productRevenue).toFixed(2)}, pages earned `
        + `$${round2(h.entryPageRevenue).toFixed(2)}, behind ${h.clicks} clicks / ${h.pages} pages — both sources agree`);
    }
    lines.push(`      override with ${HOLD_FLAG}; list with \`npm run cluster-holds\``);
  }

  // Loud on purpose, and never folded into the hold list. A category whose
  // products sold nothing while its pages earn is either broken attribution or a
  // cluster with no SKU behind it — the first is the defect that made this rule
  // pause a top-two category, the second is a content strategy with no purchase
  // path. Neither may read as a quiet "not held".
  if (hold.disagreements?.length) {
    lines.push(`  ⚠ SOURCES DISAGREE on ${hold.disagreements.length} cluster(s) — NOT held, and worth fixing:`);
    for (const d of hold.disagreements) {
      lines.push(`      ${d.cluster}: "${d.family}" products sold $0.00 over ${win}, but its pages earned `
        + `$${round2(d.entryPageRevenue)} of organic revenue. Either attribution is broken here, or these `
        + 'pages sell another category (a cluster with no SKU does exactly that).');
    }
  }

  if (hold.uncorroborated?.length) {
    lines.push(`  · ${hold.uncorroborated.length} cluster(s) sold $0 but could not be cross-checked — NOT held:`);
    for (const u of hold.uncorroborated) lines.push(`      ${u.cluster}: ${u.corroboration}`);
  }

  return lines.join('\n');
}
