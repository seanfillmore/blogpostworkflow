// lib/cluster-revenue.js
// Pure: classify each content cluster by whether it actually earns money.
//
// The fleet used to prioritize clusters by RANKING — calendar-runner accelerated
// any cluster with a page-1 post by two days. That is backwards under the Prime
// Directive, and the toothpaste cluster is the standing example: it ranks well
// enough to pull 663 clicks across 24 pages, 59% of all clustered organic clicks,
// and returns $71.50 per 90 days — 2.9% of revenue. Ranking-keyed priority read
// the clicks and kept pulling more toothpaste posts forward. Priority is keyed on
// dollars now.
//
// Note what that example is NOT, since it used to be quoted as $0: toothpaste
// EARNS, so it is not a `proven_dud` and this file will not condemn it. Being the
// least efficient cluster in the catalogue is a different finding from earning
// nothing, and it wants a different mechanism — a ranking, not a hard block.
//
// TWO INPUTS, and keeping them straight is the whole subject of this file:
//
//   1. the `clusters` array of data/reports/seo-impact/latest.json — supplies
//      `clicks` and `pages`, the CONTENT-EXPOSURE side of a verdict, plus
//      `entry_page_organic_revenue` / `revenue`, which this module no longer
//      judges on and only passes through.
//   2. `productRevenue` — cluster → what the category's PRODUCTS sold over the
//      judging window, from raw order line items. THIS is the verdict.
//
// ────────────────────────────────────────────────────────────────────────────
// WHAT `entry_page_organic_revenue` IS, AND WHY IT IS NO LONGER THE VERDICT
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
// It keeps a real job, just not this one: it is the SECOND, INDEPENDENT source
// `lib/cluster-hold.js` cross-checks a dud verdict against. Read the two-source
// note there before changing either side.
//
// ────────────────────────────────────────────────────────────────────────────
// WHAT THE VERDICT IS JUDGED ON (2026-08-23, second revision)
//
// `proven_dud` is a HARD BLOCK in four consumers, one of which (`lib/brief-triage.js`
// via `scripts/triage-orphan-briefs.mjs --drop-non-earning --apply`) archives
// paid-for research off the working set. None of them are reversible. It must
// therefore be at least as evidence-hungry as `lib/cluster-hold.js`'s spend hold,
// which only pauses LLM cycles.
//
// IT NO LONGER JUDGES ON `entry_page_organic_revenue`. That field answers "which
// PAGE earned", bucketed by a word in the landing page's URL, organic only, over
// 28 days. Asking it "did this CATEGORY earn" was always a category error, and
// the error had teeth: over the 90 days to 2026-08-20, $388.43 of organic revenue
// (29%) landed on `/`, a `/cart/...` URL or a subscription order with no landing
// page at all, so a soap bought in a cart that entered on the homepage was
// credited to the homepage and not to soap.
//
// The verdict is now `clusters_product_wide[].product_revenue_all_channels` —
// what the category's PRODUCTS sold, from raw order line items, ALL channels,
// over JUDGING_WINDOW_DAYS. Three deliberate choices, each of which changes an
// answer on real data:
//
//   · PRODUCT, not entry page. `soap` reads $324.85 rather than $0. Its verdict
//     stops depending on any threshold at all — it is `earning` outright, so the
//     click bar below is no longer what stands between it and condemnation. That
//     is the whole point of the migration: a category's survival should not rest
//     on a statistical floor when the category's own sales are measurable.
//   · ALL CHANNELS, not organic. "Did this category earn revenue for the
//     business" is the Prime Directive question; organic-only is a narrower
//     reading that can be $0 while the category plainly sells. It also carries
//     ~2× the orders (50 vs 26 over 90 days), so it is the stronger denominator.
//   · THE WIDE WINDOW, not the report's own 28 days. See JUDGING_WINDOW_DAYS.
//
// ────────────────────────────────────────────────────────────────────────────
// RE-DERIVING THE THRESHOLDS FOR THAT BASIS
//
// The old bar (MIN_CLICKS 400 / MIN_WINDOW_ORDERS 5) was derived for entry-page
// revenue, where a $0 is a direct function of the cluster's own clicks: no
// clicks, no entry-page revenue, so clicks had to carry the whole statistical
// load. Product revenue does not work that way — a category earns from carts
// that entered anywhere, on any channel — so every number below is re-derived
// rather than carried over. Measured inputs, all from production on 2026-08-20:
//
//     90-day window:  50 all-channel orders, 26 organic, $2,435.45 line subtotal
//     28-day window:  18 all-channel orders,  8 organic, 1,067 organic sessions
//     per-organic-click conversion: 8/1067 = 0.75% (28d), 26/~3430 = 0.76% (90d)
//     smallest category that genuinely sells: lip balm, 4 orders / 90d
//
// That rate is not stable to three digits and the derivations below depend on
// it: the very next day's report read 984 organic sessions against the same 8
// conversions, i.e. 0.81%. Everything here uses the LOWER figure, which is the
// conservative side for a bar that has to be high enough — at 0.81% MIN_CLICKS
// would come out at ~115 rather than 125. `tests/lib/cluster-revenue.test.js`
// recomputes each derivation from the rate rather than asserting the constant,
// so a real move in the rate fails a test instead of silently ageing the bar.
//
// THE MATERIALITY FLOOR, stated as a RATE. `lib/cluster-hold.js` already carried
// the operator's notion of "materially a channel" — one average order in the
// window — but as a per-window QUANTITY, which is circular: it is 1 by
// definition however long the window is. Restated as a rate it becomes a real
// null hypothesis, and it is the one every number below rests on:
//
//     A category we would refuse to condemn sells at least ONE AVERAGE ORDER
//     PER 28 DAYS — one order a month.
//
// JUDGING_WINDOW_DAYS. Over a W-day window such a category expects W/28 orders,
// so P(it records zero) = e^−(W/28):
//
//     W = 28 → e^−1.00 = 36.8%   ← the report's own window. A coin toss and a half.
//     W = 60 → e^−2.14 = 11.8%
//     W = 84 → e^−3.00 =  5.0%   ← the 5% point
//     W = 90 → e^−3.21 =  4.0%   ← what we use
//
// So 84 days is the minimum and 90 is what the report already computes. This is
// the arithmetic behind decision 4: the gate reads the 90-day view because a $0
// at 28 days is not an honest $0. Toothpaste is the case in point — $0 over the
// report's 28 days and $71.50 over 90.
//
// MIN_WINDOW_ORDERS = 45. The same statement in orders rather than days, because
// days and orders decouple if store volume moves, and because this is also the
// guard against a degenerate or broken order pull reading as $0 in EVERY
// category at once (a trashed GA4 property 204'd every hit for 8 days once; a
// failed Shopify page would do the same here). A floor-rate category takes a
// share s of the store's orders, s = (1 order / 28d) ÷ (50 orders / 90d) =
// 0.03571/0.55556 = 6.43%. It is absent from N orders with probability (1−s)^N:
//
//     N = 25 → 0.9357^25 = 19.0%
//     N = 45 → 0.9357^45 =  5.0%   ← the bar
//     N = 50 → 0.9357^50 =  3.6%   ← the observed 90-day window. Passes, barely.
//
// Eight orders of headroom is deliberate: a slow quarter should switch this gate
// OFF, not condemn on thinner evidence.
//
// MIN_CLICKS = 125, and its JOB HAS CHANGED. Under the entry-page basis clicks
// were the statistical evidence. Under the product basis the window carries that
// (above), and clicks are the "had a fair shot" PRECONDITION: a category whose
// content nobody has ever read has not been tested, and stamping it a dud is how
// a new category never gets a chance. Calibrated on the same measured rate: a
// cluster with k clicks in the 28-day GSC window sees ~3.214k over the 90-day
// judging window, expecting 3.214k × 0.0075 = 0.0241k orders from its OWN pages,
// so k = 125 is where that expectation reaches 3 — the same 5% point as above.
//
//     Note this is LOWER than the old 400, and that is correct rather than lax:
//     clicks no longer have to carry the whole statistical load alone. It is
//     also honest to record that the measured click→category-sales relationship
//     is much WEAKER than 0.0241/click in either direction — toothpaste turned
//     663 clicks into 5 orders where the model predicts 30; lip balm turned 6
//     clicks into 4 orders — so treat 125 as a floor on exposure, not as a
//     probability statement. The probability statement lives in the window now.
//
// MIN_PAGES = 5, unchanged, and re-examined rather than carried over: under
// EITHER basis it has no statistical content. One anomalous page could never
// have produced the $0 under the product basis anyway, because the $0 comes from
// the order pool and not from any page. It is a structural floor on "this
// category has content", and at MIN_CLICKS 125 it also asserts ~25 clicks per
// page — enough that the pages are indexed and read. Nothing in this change
// gives a reason to move it.
//
// Merging split rows into families (below) makes `proven_dud` fire MORE easily —
// a merged cluster accumulates clicks and pages faster. That fold predates this
// change and is unaffected by it: the revenue side of the verdict is now keyed
// on product title, which never had the split in the first place.

import { assignCluster } from './keyword-index/cluster.js';

/**
 * The window a $0 verdict is judged over, in days.
 *
 * Derived above: at a materiality floor of one average order per 28 days, a
 * window must span ≥84 days before a genuinely-selling category recording zero
 * drops under 5%. 90 is what `agents/seo-impact` already computes (and what
 * `lib/cluster-hold.js` re-exports as WIDE_WINDOW_DAYS), giving 4.0%.
 */
export const JUDGING_WINDOW_DAYS = 90;

/**
 * A cluster needs at least this many clicks in the report's own (28-day) window
 * before a $0 counts as a fair shot rather than an untested category.
 *
 * This is a PRECONDITION, not the evidence — see the derivation above. Re-derive
 * it if the site's organic conversion rate moves materially; it is a function of
 * that rate and of JUDGING_WINDOW_DAYS, not a round number.
 */
export const MIN_CLICKS = 125;

/** ...across at least this many pages, so a category with one post is never judged. */
export const MIN_PAGES = 5;

/**
 * ...and the judging window must itself have recorded at least this many
 * ALL-CHANNEL Shopify orders.
 *
 * Below this a floor-rate category can be absent from every order by chance
 * (>5%), so no cluster's $0 means anything — and this is the only guard against
 * a broken order pull reading as $0 in every category simultaneously. Note the
 * basis change: the old value of 5 counted ORGANIC orders in the 28-day window,
 * which is the wrong denominator for a number built from all-channel line items.
 */
export const MIN_WINDOW_ORDERS = 45;

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
 * Fold a product-revenue map through the same family taxonomy as the report rows.
 *
 * The wide rows are already keyed by `clusterForText` on a product title, so this
 * is normally the identity — but folding both sides through one function is what
 * guarantees they cannot drift, and it is cheap.
 */
function foldProductRevenue(productRevenue) {
  if (!productRevenue) return null;
  const out = {};
  for (const [raw, value] of Object.entries(productRevenue)) {
    const name = clusterForText(raw) || norm(raw);
    if (!name) continue;
    out[name] = Math.round(((out[name] || 0) + (Number(value) || 0)) * 100) / 100;
  }
  // A MAP THAT IS EMPTY, OR ALL ZEROES, IS "NOT MEASURED" — NOT "EVERY CATEGORY
  // SOLD NOTHING". Either shape would otherwise make every cluster read $0 at
  // once, which is the direction that CREATES holds, and `minWindowOrders`
  // cannot catch it: the window can hold 50 orders while the line-item join
  // produces nothing. Both shapes are reachable — an empty map when the product
  // rollup yields no rows at all, an all-zero map when it yields none but the
  // entry-page rollup does and the two are unioned. No real store takes 45+
  // orders in which literally every category sold $0, because an order is a
  // sale; so this is a broken input, and broken inputs fail open.
  //
  // Note the asymmetry that makes this safe to be wrong about: it can only ever
  // move a verdict from `proven_dud` to `unproven`, never the other way. It can
  // prevent a hold; it can never cause one.
  const values = Object.values(out);
  return values.length && values.some((v) => v > 0) ? out : null;
}

/**
 * @returns {{ [cluster:string]: { revenue:number, entryPageOrganicRevenue:number,
 *   productRevenue:number|null, clicks:number, pages:number, members:string[],
 *   status:'earning'|'proven_dud'|'unproven', evidence:string|null } }}
 *
 * - `earning`    — the category's PRODUCTS sold something in the judging window.
 *                  Any amount counts; a category that converts at low volume is
 *                  exactly what we want more of.
 * - `proven_dud` — sold nothing at all, having had a fair shot (enough clicks
 *                  across enough pages), in a window big enough that a zero is
 *                  unlikely by chance.
 * - `unproven`   — not enough evidence to judge. Left alone deliberately, or a
 *                  new category could never get tested — and the verdict for a
 *                  window too thin, or a report too old, to condemn anything.
 *
 * ONE SOURCE ONLY. This is the primary number and nothing else. The second,
 * independent source — what the category's PAGES earned — is applied by
 * `lib/cluster-hold.js`'s `corroborateClusters`, and anything that blocks or
 * deletes must read `corroboratedClassification`, never this directly.
 *
 * @param {Array} clusters  the report's `clusters` rows (clicks, pages, entry-page $)
 * @param {object} [opts]
 * @param {Record<string,number>|null} [opts.productRevenue]  cluster → what its
 *   products sold over the judging window, all channels. REQUIRED for any cluster
 *   to be a `proven_dud`: this IS the evidence, and a report written before the
 *   field existed simply cannot support the verdict. Fails open — see below.
 * @param {number|null} [opts.windowOrders]  all-channel Shopify orders in that
 *   same window. REQUIRED for the same reason: an unknown denominator is not
 *   evidence, and a broken order pull must not read as every category dying at
 *   once.
 */
export function classifyClusters(clusters, {
  minClicks = MIN_CLICKS, minPages = MIN_PAGES, minWindowOrders = MIN_WINDOW_ORDERS,
  productRevenue = null, windowOrders = null,
} = {}) {
  const sold = foldProductRevenue(productRevenue);
  const ordersSufficient = windowOrders !== null && Number(windowOrders) >= minWindowOrders;

  // A category that SOLD but has no clustered entry page still gets a row. That
  // case is the entire reason this basis exists — it was previously invisible —
  // and it is safe by construction: with no clicks and no pages it can only ever
  // be `earning` or `unproven`, never a dud.
  const folded = foldClusterRows(clusters);
  for (const name of Object.keys(sold || {})) {
    if (!folded[name]) {
      folded[name] = {
        cluster: name, entryPageOrganicRevenue: 0, revenue: 0, clicks: 0, pages: 0, members: [],
      };
    }
  }

  const out = {};
  for (const [name, c] of Object.entries(folded)) {
    const productRev = sold ? (sold[name] || 0) : null;
    let status; let evidence = null;

    if (productRev === null) {
      // No product-revenue reading at all — an old report, or a run where the
      // order pull failed. The gate has no evidence and says so rather than
      // falling back to the entry-page number, which is the misreading this
      // whole change exists to end.
      status = 'unproven';
      evidence = 'no product-revenue reading for the judging window — $0 cannot be judged from entry-page attribution alone';
    } else if (productRev > 0) {
      status = 'earning';
    } else if (!ordersSufficient) {
      // Absent or too-thin order data is not evidence of $0. Fail toward
      // unproven: nothing gets blocked, nothing gets deleted.
      status = 'unproven';
      evidence = windowOrders === null
        ? 'the judging window\'s order count was not supplied — $0 cannot be judged'
        : `the judging window recorded only ${windowOrders} order(s), below the ${minWindowOrders} needed to judge any cluster's $0`;
    } else if (c.clicks >= minClicks && c.pages >= minPages) {
      status = 'proven_dud';
      evidence = `products sold $0.00 across ${windowOrders} orders in the judging window, `
        + `with ${c.clicks} clicks / ${c.pages} pages of content behind them`;
    } else {
      status = 'unproven';
      evidence = `${c.clicks} clicks across ${c.pages} pages is below the ${minClicks} clicks / ${minPages} pages `
        + 'that count as a fair shot, so $0 of product revenue is not yet evidence';
    }
    out[name] = { ...c, productRevenue: productRev, status, evidence };
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
