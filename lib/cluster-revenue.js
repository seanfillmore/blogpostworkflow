// lib/cluster-revenue.js
// Pure: classify each content cluster by whether it actually earns money.
//
// The fleet used to prioritize clusters by RANKING — calendar-runner accelerated
// any cluster with a page-1 post by two days. That is backwards under the Prime
// Directive: the toothpaste cluster ranks well enough to pull 663 clicks across
// 24 pages and has returned $0, so ranking-keyed priority kept pulling more
// toothpaste posts forward. Priority is keyed on dollars now.
//
// Input is the `clusters` array of data/reports/seo-impact/latest.json:
//   { cluster, entry_page_organic_revenue, revenue, revenuePrev, clicks, pages }
//
// ────────────────────────────────────────────────────────────────────────────
// WHAT THAT NUMBER IS, AND WHAT IT IS NOT
//
// It is ENTRY-PAGE-CREDITED, ORGANIC-SEARCH-ONLY revenue over the report's own
// (28-day) window, bucketed by a word in the URL of the page the session landed
// on. It is NOT product revenue and it is NOT a category's sales.
//
// It reconciles exactly to `totals.organic_revenue` and nothing else: on the
// 2026-08-22 report, $462.14 across the cluster rows + $77.94 landing on `/`
// (which matches no cluster) = $540.08. The figure is correct — it is just far
// narrower than the word "revenue" suggests, and that mislabelling is precisely
// how a category selling ~$430/90d came to be read as $0. The canonical field is
// therefore `entry_page_organic_revenue`; `revenue` is kept as a back-compatible
// alias for the same number and nothing else.
//
// ────────────────────────────────────────────────────────────────────────────
// THE EVIDENCE BAR FOR `proven_dud`, AND WHY IT MOVED (2026-08-23)
//
// `proven_dud` is a HARD BLOCK in four consumers, one of which (`lib/brief-triage.js`
// via `scripts/triage-orphan-briefs.mjs --drop-non-earning --apply`) `unlinkSync`s
// paid-for research off disk. None of them are reversible. It must therefore be
// at least as evidence-hungry as `lib/cluster-hold.js`'s spend hold, which only
// pauses LLM cycles.
//
// The old bar (≥100 clicks across ≥5 pages) gated on TRAFFIC sufficiency and
// never on ORDER-COUNT sufficiency. Do the arithmetic the old bar never did.
// The 2026-08-22 window recorded 8 organic orders across 1,067 organic sessions
// — a 0.75% per-session conversion rate, and GSC clicks track organic sessions
// closely here (1,132 clustered clicks vs 1,067 sessions). Model "did this
// cluster record zero orders?" as Poisson with λ = clicks × 0.0075:
//
//     100 clicks → λ=0.75 → P(zero) = 47%    ← the OLD bar. A coin flip.
//     223 clicks → λ=1.67 → P(zero) = 19%    ← what condemned `soap`.
//     400 clicks → λ=3.00 → P(zero) =  5%    ← the new bar.
//     663 clicks → λ=4.97 → P(zero) = 0.7%   ← toothpaste. Still a dud.
//
// So `MIN_CLICKS` is 400: the point at which a $0 stops being the most likely
// outcome of a category that sells perfectly well and starts being evidence.
// Note this alone would have spared `soap` even without the taxonomy fold below
// — two independent defects each condemned it, and both are fixed here.
//
// `MIN_WINDOW_ORDERS` is the precondition the whole derivation rests on: the
// 0.75% rate is estimated FROM the window, so a window with almost no orders
// cannot support it. Worse, a store-wide measurement outage (a trashed GA4
// property 204'd every hit for 8 days once) reads as $0 in EVERY cluster at
// once, which under a clicks-only bar stamps every high-traffic category a dud
// in a single unattended run. Below the floor the honest verdict is `unproven`.
//
// Merging split rows into families (below) makes `proven_dud` fire MORE easily —
// a merged cluster accumulates clicks and pages faster while $0 stays $0. That
// is why the fold and the raised bar had to land together: separately, either
// one trades a false dud on `soap` for a false dud on something else.

import { assignCluster } from './keyword-index/cluster.js';

/**
 * A cluster needs at least this many clicks before $0 counts as evidence.
 * Derived above from the measured 0.75% organic conversion rate: 400 clicks is
 * λ=3, i.e. a 5% chance a genuinely-selling category records zero. Re-derive it
 * if site conversion moves materially — it is a function of that rate, not a
 * round number.
 */
export const MIN_CLICKS = 400;

/** ...across at least this many pages, so one dead page cannot condemn a category. */
export const MIN_PAGES = 5;

/**
 * ...and the window itself must have recorded at least this many organic orders.
 *
 * Below this the conversion rate MIN_CLICKS is derived from cannot be estimated
 * at all, so no cluster's $0 means anything. It is also the only guard against a
 * store-wide tracking outage condemning every cluster in one run. Five is the
 * floor at which a rate is estimable; the observed window carried 8.
 */
export const MIN_WINDOW_ORDERS = 5;

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * The clusters that name something Real Skin Care actually sells.
 *
 * `assignCluster` also answers 'brand' (navigational), 'hair' (RSC sells no hair
 * products) and 'unclustered'. None of those are a product category, so they map
 * to null here rather than becoming rows in a revenue report — their traffic
 * belongs in the residual, which the report now shows explicitly.
 */
export const PRODUCT_CLUSTERS = ['deodorant', 'toothpaste', 'lip balm', 'soap', 'lotion', 'coconut oil'];
const PRODUCT_SET = new Set(PRODUCT_CLUSTERS);

/**
 * Brand phrases stripped before assignment.
 *
 * `assignCluster`'s first rule is navigational-brand, which is right for a search
 * QUERY ("real skin care lotion" is someone looking for us) and wrong for a page
 * PATH, where the brand name is decoration: `/blogs/news/best-clean-body-lotion-
 * soft-skin-zero-toxins-real-skin-care` is a lotion page, and left alone it
 * classified as 'brand' → null and dropped out of the lotion cluster entirely.
 * Measured against 342 real GSC paths, this was the only false drop.
 */
const BRAND_PHRASES = /\breal\s?skin\s?care\b|\breal\s?skincare\b|\brealskin\b/g;

/**
 * Map a URL path, slug or keyword to a cluster name, or null.
 *
 * ONE TAXONOMY, NOT TWO. This delegates to `lib/keyword-index/cluster.js`'s
 * `assignCluster` — the fleet's ordered, word-boundary cluster vocabulary, which
 * `lib/cluster-hold.js` already uses to compare attributed revenue against real
 * Shopify orders. It used to hand-maintain a second, first-match-wins
 * `String.includes` list, and that list is what caused the incident this file
 * now documents:
 *
 *   'hand soap' sat at position 9 and 'soap' at position 12, so
 *   /products/organic-foaming-hand-soap matched 'hand soap' first and soap's
 *   ONLY in-window organic order ($62.40) was credited to a different cluster —
 *   leaving `soap` reading $0 on 223 clicks across 24 pages, stamped
 *   `proven_dud`, while the category really sold ~$430 over 90 days (19% of all
 *   revenue, second only to lotion) with a paid giveaway campaign running.
 *
 * The same split shredded the lotion family four ways ('body lotion' held
 * $313.49 while 'lotion', 'moisturizer' and 'body cream' each read $0). The
 * docstring here previously argued FOR keeping 'hand soap' separate ("it is its
 * own product line, not a spelling of the same thing"). It is a product line;
 * it is not a separate evidence pool, and treating it as one is what let a
 * category be condemned on a fraction of its own numbers.
 *
 * `hand soap`, `bar soap` and `foaming` now all fold to `soap`; `body lotion`,
 * `moisturizer`, `body cream` and `cream` all fold to `lotion`.
 */
export function clusterForText(text) {
  const t = norm(text).replace(/[-_/.]+/g, ' ').replace(BRAND_PHRASES, ' ');
  if (!t.trim()) return null;
  const c = assignCluster(t);
  return PRODUCT_SET.has(c) ? c : null;
}

/**
 * Fold a report's cluster rows into families, summing their evidence.
 *
 * Applied to the report AS READ, not only to reports written after the taxonomy
 * fix: `data/reports/seo-impact/latest.json` is written on the server and is
 * routinely a day or more old, so a classification that only worked on freshly
 * generated rows would leave the live defect in place until the next cron run.
 *
 * A row whose name maps to no product family keeps its own name rather than
 * being dropped — losing it would silently shrink the report — but it can never
 * reach a blocking decision, because `lib/cluster-hold.js` refuses to corroborate
 * a cluster it cannot map to a product family.
 *
 * @returns {Record<string,{cluster:string, entryPageOrganicRevenue:number,
 *   revenue:number, clicks:number, pages:number, members:string[]}>}
 */
export function foldClusterRows(clusters) {
  const out = {};
  for (const c of (clusters || [])) {
    const raw = norm(c?.cluster);
    if (!raw) continue;
    const name = clusterForText(raw) || raw;
    // Canonical field first; `revenue` is the back-compatible alias for the same
    // number, so a report written before the rename still classifies correctly.
    const revenue = Number(c.entry_page_organic_revenue ?? c.entryPageOrganicRevenue ?? c.revenue) || 0;
    const cur = out[name] || {
      cluster: name, entryPageOrganicRevenue: 0, revenue: 0, clicks: 0, pages: 0, members: [],
    };
    cur.entryPageOrganicRevenue = Math.round((cur.entryPageOrganicRevenue + revenue) * 100) / 100;
    cur.revenue = cur.entryPageOrganicRevenue;
    cur.clicks += Number(c.clicks) || 0;
    cur.pages += Number(c.pages) || 0;
    if (!cur.members.includes(raw)) cur.members.push(raw);
    out[name] = cur;
  }
  return out;
}

/**
 * @returns {{ [cluster:string]: { revenue:number, entryPageOrganicRevenue:number,
 *   clicks:number, pages:number, members:string[], status:'earning'|'proven_dud'|'unproven',
 *   evidence:string|null } }}
 *
 * - `earning`    — returned money in the window. Any amount counts; a cluster
 *                  that converts at low volume is exactly what we want more of.
 * - `proven_dud` — had a fair shot (enough clicks that a zero is unlikely by
 *                  chance, across several pages, in a window that recorded
 *                  enough orders to judge by) and returned nothing.
 * - `unproven`   — not enough evidence to judge. Left alone deliberately, or a
 *                  new category could never get tested — and, since 2026-08-23,
 *                  the verdict for a window too thin to condemn anything.
 *
 * @param {Array} clusters  the report's `clusters` rows
 * @param {object} [opts]
 * @param {object} [opts.totals]  the report's `totals` block. REQUIRED for any
 *   cluster to be a `proven_dud`: without it the window's order count is unknown,
 *   and an unknown denominator is not evidence. Every production caller reads the
 *   whole report and passes it.
 */
export function classifyClusters(clusters, {
  minClicks = MIN_CLICKS, minPages = MIN_PAGES, minWindowOrders = MIN_WINDOW_ORDERS, totals = null,
} = {}) {
  const windowOrders = totals ? (Number(totals.organic_conversions) || 0) : null;
  const ordersSufficient = windowOrders !== null && windowOrders >= minWindowOrders;

  const out = {};
  for (const [name, c] of Object.entries(foldClusterRows(clusters))) {
    let status; let evidence = null;
    if (c.entryPageOrganicRevenue > 0) {
      status = 'earning';
    } else if (!ordersSufficient) {
      // Absent or too-thin order data is not evidence of $0. Fail toward
      // unproven: nothing gets blocked, nothing gets deleted.
      status = 'unproven';
      evidence = windowOrders === null
        ? 'the window\'s organic order count was not supplied — $0 cannot be judged'
        : `the window recorded only ${windowOrders} organic order(s), below the ${minWindowOrders} needed to judge any cluster's $0`;
    } else if (c.clicks >= minClicks && c.pages >= minPages) {
      status = 'proven_dud';
      evidence = `$0 across ${c.clicks} clicks / ${c.pages} pages in a window with ${windowOrders} organic orders`;
    } else {
      status = 'unproven';
      evidence = `${c.clicks} clicks across ${c.pages} pages is below the ${minClicks} clicks / ${minPages} pages needed before $0 is evidence`;
    }
    out[name] = { ...c, status, evidence };
  }
  return out;
}

/** Look up a calendar item's `category` against the classification. */
export function clusterStatus(classified, category) {
  const name = norm(category);
  return (classified?.[name] || classified?.[clusterForText(name)])?.status || 'unproven';
}

/** Cluster names that should not receive new content, for prompts and reports. */
export function provenDuds(classified) {
  return Object.entries(classified || {})
    .filter(([, v]) => v.status === 'proven_dud')
    .sort((a, b) => b[1].clicks - a[1].clicks)
    .map(([cluster, v]) => ({ cluster, ...v }));
}
