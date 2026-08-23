// lib/cluster-efficiency.js
//
// DEPRIORITISE, DO NOT CONDEMN. The other half of "if it doesn't drive revenue,
// we put it on hold" — the half that applies to a cluster which DOES drive
// revenue, just very little of it per unit of attention it consumes.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A SECOND HOLD.
//
// `lib/cluster-hold.js` answers ONE question: did this category earn literally
// nothing? On 2026-08-23 the answer became "no cluster did", and it will usually
// be "no cluster did": at ~50 all-channel orders per 90 days the gate needs 45 in
// the window before a $0 means anything, so this store can barely reach the bar
// at all. The gate is right to admit that. It is also, on its own, no longer
// enough — because the business fact that started this did not go away:
//
//     toothpaste takes 59% of clustered organic clicks (640 of 1,114) and
//     returns 2.9% of the revenue ($71.50 of $2,435.45) over the same 90 days.
//
// That is not a $0 verdict and must never be treated as one. `proven_dud` is
// wired to a spend pause AND to brief archival — a path that has already
// permanently destroyed three paid-for briefs — and no threshold should be bent
// until it produces the answer somebody wanted. So the answer to "earns a
// little, very inefficiently" is a RANKING: the efficient clusters are reached
// first and the inefficient ones get what is left, rather than nothing.
//
// ────────────────────────────────────────────────────────────────────────────
// THE MEASURE: revenue per click, with a fair shot's worth of pseudo-clicks.
//
//     score = productRevenue / (clicks + PRIOR_CLICKS)
//
// · The NUMERATOR is `clusters_product_wide[].product_revenue_all_channels` —
//   source A, what the CATEGORY SOLD, from raw order line items over the 90-day
//   judging window. Not `entry_page_organic_revenue`. Asking the entry-page
//   figure "is this category worth investing in" is the category error that had
//   soap condemned at $0 while it sold $324.85, and a ranking built on it would
//   be that same misreading wearing a softer consequence.
//
// · The DENOMINATOR is clicks, not pages. Clicks are an OUTCOME — the demand a
//   cluster actually attracts. Pages are a DECISION — how much we chose to
//   publish. Dividing by pages rewards a cluster for our own restraint and
//   forgives it for our own over-publishing, which is backwards here: toothpaste
//   scores better per page (24 pages) than per click (640 clicks) precisely
//   because we over-published it, and the operator's own statement of the
//   problem ("59% of the clicks for 2.9% of the revenue") is a click statement.
//   `revenuePerPage` is REPORTED on every row so the page-count disparity stays
//   visible; nothing sorts on it. A blend was tried and moves exactly one pair
//   (soap/lip balm) while making the number impossible to explain.
//
// · THE RATIO IS AN INDEX, NOT A PRICE. 90-day all-channel dollars over 28-day
//   organic clicks is not literally "dollars per click" and must never be quoted
//   as one. Every cluster carries the identical window and channel mismatch, so
//   comparing clusters ON ONE REPORT is valid; the absolute level means nothing
//   and does not survive a change of window.
//
// ────────────────────────────────────────────────────────────────────────────
// THE SMALL-SAMPLE GUARD, and which direction it shrinks.
//
// Lip balm sold $117 behind SIX organic clicks. Raw revenue-per-click makes it
// the most efficient cluster in the catalogue by 13× — it ranks FIRST, ahead of
// lotion, on a sample of six. That is the artefact, and it has a structural
// cause worth naming: product revenue is all-channel while clicks are organic
// search, so a cluster whose buyers arrive elsewhere divides a real numerator by
// a near-zero denominator. The number is not measuring conversion at all.
//
// PRIOR_CLICKS adds a fair shot's worth of clicks that earned nothing to every
// denominator. `PRIOR_CLICKS === MIN_CLICKS`, IMPORTED and never re-declared:
// that constant is already derived, in `lib/cluster-revenue.js`, as the click
// count at which a cluster's own pages are expected to produce three orders over
// the judging window — precisely the point at which its click data starts
// carrying evidence. Below it the score is dominated by the penalty; at it the
// cluster's own evidence is half the estimate; well above it the penalty fades.
//
// IT SHRINKS TOWARD ZERO, NOT TOWARD THE SITE AVERAGE, and that is the whole
// design decision. Regressing a thin sample to the mean is the textbook move and
// it is wrong here: `coconut oil` sold $0 across all 50 orders in the window, and
// mean-shrinkage would rank that as merely average — third of six, above soap,
// which is 13% of the store's revenue with a paid campaign live. The evidence for
// a $0 comes from the ORDER POOL, not from the cluster's own clicks (this is the
// same insight that moved the dud gate onto product revenue), so "we have not
// seen many clicks" may never be read as "it is probably fine". Shrinking toward
// zero says the honest thing instead: a high rate is not credited until enough
// clicks stand behind it. It is conservative on the upside only, which is why
// the anti-starvation reserve below exists to compensate rather than the
// estimator being softened.
//
// This is the same shape as PR #638's guard on the dud gate — there, a $0 is not
// evidence until the window is big enough; here, a high rate is not evidence
// until the click count is big enough. Same question, opposite tail.
//
// ────────────────────────────────────────────────────────────────────────────
// HOW IT COMPOSES WITH THE HOLD. It does not duplicate it and cannot fight it.
//
// The hold EXCLUDES; the ranking ORDERS what survives. Held clusters are already
// gone from every gated pick list, so the ranking normally never sees them —
// but under `--include-held` it does, and it reads `hold.heldSet` for exactly
// two purposes: to mark such a row `held: true` (it sorts last by construction
// anyway, since a held cluster's product revenue is $0), and to guarantee the
// anti-starvation reserve below can NEVER target a held cluster. Reserving a
// slot for a cluster the hold excluded would quietly undo the hold. No hold
// logic is re-implemented here and no cluster is named.
//
// ────────────────────────────────────────────────────────────────────────────
// IT MUST NOT STARVE A CLUSTER TO ZERO — that would be the hard block again.
//
// A strict order plus a per-run cap is a block by arithmetic: with four lotion
// candidates and a budget of four, toothpaste is untouched this week, next week
// and every week. So when a caller passes its cap, ONE slot inside that cap is
// reserved for the worst-ranked cluster PRESENT in the list that the hold has
// not excluded. The reserve fires only at `limit >= RESERVE_MIN_LIMIT`: below
// three slots a reserved one is a third or more of the budget, which is a
// co-equal share rather than "what is left", and it would invert the ranking it
// is meant to soften. At the caps that actually run (3, 5, 6) it is 33%, 20% and
// 17%.
//
// ────────────────────────────────────────────────────────────────────────────
// IT DEGRADES, IT DOES NOT FAIL SAFE — because it destroys nothing.
//
// Per CLAUDE.md's split: things that block or delete fail safe, things that rank
// or display degrade. A missing report, a stale one, or one carrying no
// `clusters_product_wide[]` yields NO ranking and the pick list comes back in
// exactly the order the picker built it. It never falls back to the entry-page
// figure to have something to sort by. `efficiencyBanner()` says so out loud, for
// the same reason `hold.disarmed` exists: a ranking that quietly stopped ranking
// looks identical to one with nothing to reorder.

import { MIN_CLICKS } from './cluster-revenue.js';
import { clusterForItem } from './cluster-hold.js';

/**
 * Pseudo-clicks added to every denominator — a fair shot's worth of clicks that
 * earned nothing.
 *
 * IMPORTED, never re-declared. It is `lib/cluster-revenue.js`'s MIN_CLICKS,
 * derived there from the measured organic conversion rate; a second copy would
 * drift the way `AWARENESS_LEVELS` did before it was consolidated.
 */
export const PRIOR_CLICKS = MIN_CLICKS;

/**
 * The smallest per-run cap at which a slot may be reserved for the bottom
 * cluster. Below this the reserve is a third or more of the budget.
 */
export const RESERVE_MIN_LIMIT = 3;

/**
 * One cluster's score. Exported so a test can recompute it from the imported
 * constant rather than assert a number somebody typed.
 */
export function efficiencyScore(productRevenue, clicks, { priorClicks = PRIOR_CLICKS } = {}) {
  const rev = Number(productRevenue) || 0;
  const c = Math.max(0, Number(clicks) || 0);
  return rev / (c + priorClicks);
}

const ratio = (n, d) => ((Number(d) || 0) > 0 ? (Number(n) || 0) / Number(d) : null);

/**
 * Rank every cluster in a hold context by efficiency.
 *
 * @param {object} hold  from `loadClusterHold` / `buildClusterHold`
 * @returns {{available:boolean, reason:string|null, priorClicks:number,
 *            generatedAt:string|null, judgingWindow:object|null, totalRevenue:number,
 *            totalClicks:number, ordered:Array, rankOf:Map<string,number>,
 *            reserveCluster:string|null}}
 *
 * `ordered` rows carry `{cluster, rank, held, productRevenue, entryPageRevenue,
 * clicks, pages, revenuePerClick, revenuePerPage, score}`. `revenuePerClick` and
 * `revenuePerPage` are DIAGNOSTICS for the operator — `score` is the sort key.
 */
export function rankClusters(hold, { priorClicks = PRIOR_CLICKS } = {}) {
  const none = (reason) => ({
    available: false,
    reason,
    priorClicks,
    generatedAt: hold?.generatedAt || null,
    judgingWindow: hold?.judgingWindow || null,
    totalRevenue: 0,
    totalClicks: 0,
    ordered: [],
    rankOf: new Map(),
    reserveCluster: null,
  });

  if (!hold) return none('no cluster-hold context was supplied — clusters are not ranked this run');
  if (!hold.available) {
    return none(hold.stale
      ? 'the seo-impact report is stale, so clusters are not ranked this run — the pick list keeps its own order'
      : 'the seo-impact report is missing or unreadable, so clusters are not ranked this run — the pick list keeps its own order');
  }

  const rows = Object.entries(hold.classified || {});
  if (!rows.length) return none('the report contains no clusters — nothing to rank');

  // ALL-OR-NOTHING BY CONSTRUCTION: `classifyClusters` sets `productRevenue` to
  // null on every row when the product reading is absent or unusable, so this
  // is the pre-migration / broken-order-pull shape. Ranking on the entry-page
  // figure instead is the one fallback that is never allowed.
  if (!rows.some(([, v]) => v?.productRevenue !== null && v?.productRevenue !== undefined)) {
    return none('the report carries no product-revenue reading for the judging window, so clusters cannot '
      + 'be ranked by efficiency — the pick list keeps its own order (ranking on entry-page revenue is '
      + 'the misreading this basis exists to end)');
  }

  const entries = rows.map(([cluster, v]) => {
    const productRevenue = Number(v?.productRevenue) || 0;
    const clicks = Number(v?.clicks) || 0;
    const pages = Number(v?.pages) || 0;
    return {
      cluster,
      held: !!hold.heldSet?.has(cluster),
      productRevenue,
      entryPageRevenue: hold.corroborated?.[cluster]?.entryPageRevenue ?? null,
      clicks,
      pages,
      revenuePerClick: ratio(productRevenue, clicks),
      revenuePerPage: ratio(productRevenue, pages),
      score: efficiencyScore(productRevenue, clicks, { priorClicks }),
    };
  });

  entries.sort((a, b) => b.score - a.score
    // A held cluster is a stronger negative verdict than an unproven $0, so it
    // loses every tie rather than sorting by name against one.
    || (a.held === b.held ? 0 : (a.held ? 1 : -1))
    || b.productRevenue - a.productRevenue
    || a.clicks - b.clicks
    || String(a.cluster).localeCompare(String(b.cluster)));
  entries.forEach((e, i) => { e.rank = i; });

  const unheld = entries.filter((e) => !e.held);
  return {
    available: true,
    reason: null,
    priorClicks,
    generatedAt: hold.generatedAt || null,
    judgingWindow: hold.judgingWindow || null,
    totalRevenue: entries.reduce((s, e) => s + e.productRevenue, 0),
    totalClicks: entries.reduce((s, e) => s + e.clicks, 0),
    ordered: entries,
    rankOf: new Map(entries.map((e) => [e.cluster, e.rank])),
    // Informational: the cluster that would be reserved for if it had an item in
    // the list. Null when fewer than two clusters could ever be starved of one
    // another. The per-call target is computed from the items actually present.
    reserveCluster: unheld.length >= 2 ? unheld[unheld.length - 1].cluster : null,
  };
}

/**
 * Reorder a pick list so the efficient clusters are reached first.
 *
 * ITEMS THAT NAME NO CLUSTER ARE NOT MOVED. They keep the exact index the picker
 * gave them, and the clustered items are permuted among the remaining slots.
 * That is deliberate: an item we cannot place carries no evidence either way, and
 * every alternative (rank it average, rank it last) is an invented constant that
 * would quietly promote or demote the whole legacy corpus, much of which records
 * no target keyword at all.
 *
 * ORDER, THEN CAP — the same rule the hold already follows. The caller still
 * applies its own `.slice(0, limit)`; passing `limit` here only tells the reserve
 * where the cap falls.
 *
 * @param {Array} items
 * @param {object} ranking from `rankClusters`
 * @param {{limit?:number|null, describe?:(item:any)=>object, reserve?:boolean}} opts
 * @returns {{items:Array, reordered:boolean, ranked:number, unranked:number,
 *            reserved:{cluster:string, position:number, displaced:string|null}|null}}
 */
export function orderByEfficiency(items, ranking, {
  limit = null, describe = (i) => i, reserve = true,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const idle = {
    items: [...list], reordered: false, ranked: 0, unranked: list.length, reserved: null,
  };
  if (!ranking?.available || !ranking.ordered?.length || !list.length) return idle;

  const slots = [];
  const clustered = [];
  list.forEach((item, idx) => {
    const cluster = clusterForItem(describe(item) || {});
    const rank = cluster == null ? undefined : ranking.rankOf.get(cluster);
    if (rank === undefined) return;
    slots.push(idx);
    clustered.push({ item, idx, cluster, rank });
  });
  if (!clustered.length) return idle;

  const sorted = [...clustered].sort((a, b) => a.rank - b.rank || a.idx - b.idx);
  const reserved = reserve ? applyReserve(sorted, slots, limit, ranking) : null;

  const out = [...list];
  sorted.forEach((entry, i) => { out[slots[i]] = entry.item; });
  const moved = out.some((item, i) => item !== list[i]);
  return {
    items: out,
    reordered: moved || !!reserved,
    ranked: clustered.length,
    unranked: list.length - clustered.length,
    reserved,
  };
}

/**
 * Push the worst-ranked cluster present into the last slot inside the cap.
 *
 * Mutates `sorted`. Returns what was reserved, or null when the reserve does not
 * apply — no cap, a cap too small to spare a slot, only one cluster present, or
 * the bottom cluster already inside the cap.
 *
 * THE TARGET IS NEVER A HELD CLUSTER. That is the one place this module reads the
 * hold, and skipping it would let the anti-starvation rule silently re-admit a
 * cluster two independent sources agreed earns nothing.
 */
function applyReserve(sorted, slots, limit, ranking) {
  const cap = Number(limit);
  if (!Number.isFinite(cap) || cap < RESERVE_MIN_LIMIT) return null;

  // How many clustered items fall inside the cap. Unclustered items keep their
  // slots, so they consume budget without being reorderable — count real slots.
  const inCap = slots.filter((s) => s < cap).length;
  if (inCap < RESERVE_MIN_LIMIT) return null;

  const heldClusters = new Set(ranking.ordered.filter((e) => e.held).map((e) => e.cluster));
  const eligible = sorted.filter((e) => !heldClusters.has(e.cluster));
  if (!eligible.length) return null;
  const target = eligible[eligible.length - 1].cluster;
  // Only one eligible cluster in the list: nothing is being crowded out.
  if (eligible.every((e) => e.cluster === target)) return null;

  const reserveAt = inCap - 1;
  if (sorted.slice(0, inCap).some((e) => e.cluster === target)) return null;

  const pick = sorted.findIndex((e) => e.cluster === target);
  if (pick <= reserveAt) return null;
  const displaced = sorted[reserveAt];
  const [entry] = sorted.splice(pick, 1);
  sorted.splice(reserveAt, 0, entry);
  return {
    cluster: target,
    position: reserveAt + 1,
    displaced: describeSlug(displaced?.item) || null,
  };
}

function describeSlug(item) {
  if (!item) return null;
  if (typeof item === 'string') return item;
  return item.slug || item.keyword || item.url || null;
}

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

/**
 * The startup banner. Empty on a normal ranked run — the only silent case, and
 * the usual one — and loud when the ranking is OFF, because a run that stopped
 * ranking otherwise looks exactly like a run with nothing to reorder.
 */
export function efficiencyBanner(ranking) {
  if (ranking?.available) return '';
  return `  · Clusters are NOT ranked by efficiency this run: ${ranking?.reason || 'no ranking available'}.`;
}

/**
 * Console + digest lines describing the order this run actually used.
 *
 * Deliberately small: this appears in every gated agent's deferred `notify()`
 * body, so it must stay tolerable repeated six times a morning. Empty when the
 * ranking was unavailable or moved nothing.
 */
export function renderEfficiencyLines(ranking, result, { max = 6 } = {}) {
  if (!ranking?.available || !result?.reordered) return [];
  const order = ranking.ordered.slice(0, max).map((e) => `${e.cluster} ${money(e.score)}`).join(' > ');
  const lines = [
    `Cluster efficiency order (revenue per click + ${ranking.priorClicks} pseudo-clicks, `
    + `${ranking.judgingWindow ? `${ranking.judgingWindow.start} → ${ranking.judgingWindow.end}` : '90d'}): ${order}`,
    `  ${result.ranked} of ${result.ranked + result.unranked} item(s) reordered so the efficient clusters are `
    + 'reached first; nothing is blocked and every cluster stays eligible.',
  ];
  if (result.reserved) {
    lines.push(`  Slot ${result.reserved.position} RESERVED for "${result.reserved.cluster}", the lowest-ranked `
      + 'cluster in this pick list, so a ranking never starves one to zero'
      + `${result.reserved.displaced ? ` (displaced: ${result.reserved.displaced})` : ''}.`);
  }
  return lines;
}
