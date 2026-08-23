// lib/queue-autoapply.js
//
// PURE policy for `agents/queue-autoapply` — no I/O, no Shopify, no fs, so the
// whole decision surface is testable without stubbing anything. The agent does
// the reading, the editor runs and the Shopify writes; this file only ever
// answers "what should happen to this item, and why".
//
// The policy is Sean's, verbatim: **auto-apply, revenue-gated.**
//
//   - Content/meta items auto-apply after an editor gate.
//   - collection-gap items auto-DISMISS when they fail the 2+ distinct products
//     rule or land in a cluster that has been proven to earn $0. They never
//     auto-apply: creating a collection multiplies commercial pages, which is
//     what produced 62 live collections for 9 products (Prime Directive).
//   - Anything whose schema this file does not recognise is left strictly
//     alone. `agents/pdp-builder` writes into the same directory with a
//     different shape (`type:` instead of `trigger:`, status `needs_rework`),
//     and those artifacts belong to their own producer.

import { clusterForText } from './cluster-revenue.js';

/**
 * Triggers the agent is allowed to push live on its own.
 * Every one of these is an edit to a page that ALREADY exists — a refreshed
 * body, or a title/description on a live URL. None of them creates a new page.
 */
export const AUTO_APPLY_TRIGGERS = new Set([
  'seo-opportunity',
  'quick-win',
  'flop-refresh',
  'page-meta-rewrite',
  'low-ctr-meta',
  'legacy-flop',
]);

/**
 * Per-run ceiling on LIVE applies. Deliberately small.
 *
 * The backlog this agent was built to drain is 21 items, the oldest 37 days
 * old. Applying 21 Shopify writes in one unattended 8 AM run is not a first
 * run, it is an incident: nothing else in the fleet mutates that many live
 * pages at once, and a systematic fault in the refresh content would land on
 * every page before anyone read the digest. Five a day clears the current
 * backlog inside a week while keeping any bad day's blast radius to five pages
 * that all have a backup and a recorded revert plan.
 *
 * Dismissals are NOT capped — they touch a local JSON file and nothing else.
 */
export const MAX_APPLIES_PER_RUN = 5;

/**
 * A collection exists only where a category holds 2 or more distinct products.
 * This is the one hardcoded number in the policy (CLAUDE.md, Prime Directive);
 * cluster revenue is read from data/reports/seo-impact/latest.json instead of
 * being hardcoded, because which clusters earn money changes month to month.
 */
export const MIN_COLLECTION_PRODUCTS = 2;

/** Matches `activeSlugs()` in agents/performance-engine/lib/queue.js. */
export const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** How many times a gated item may be sent through repair before we stop. */
export const MAX_GATE_ATTEMPTS = 3;

/**
 * The POST slug an item ultimately edits.
 *
 * A seo-opportunity item is filed under `seo-opp-<slug>` but the page it
 * changes is `<slug>` — which may separately carry its own refresh item. Pure
 * string derivation on purpose: resolving the real post directory is I/O, and
 * this only needs to be good enough to notice a collision.
 */
export function targetSlugFor(item) {
  const slug = String(item?.slug || '');
  return slug.startsWith('seo-opp-') ? slug.slice('seo-opp-'.length) : slug;
}

/** An item this agent understands at all. Anything else is another producer's. */
export function isKnownSchema(item) {
  return !!(item && typeof item.trigger === 'string' && item.trigger && typeof item.slug === 'string' && item.slug);
}

/**
 * Target slugs that are inside the 30-day post-action cooldown because SOME
 * OTHER queue item already acted on them. Mirrors `activeSlugs()`'s terminal-
 * state reading; an item never blocks itself.
 *
 * @returns {Set<string>}
 */
export function cooldownTargets(items, { now = Date.now(), cooldownMs = COOLDOWN_MS } = {}) {
  const out = new Set();
  for (const i of items || []) {
    if (!i) continue;
    const stamp = i.status === 'published' ? i.published_at
      : i.status === 'completed' ? i.completed_at
        : null;
    if (stamp === null) continue;           // not a terminal, actioned state
    if (!stamp) { out.add(targetSlugFor(i)); continue; } // actioned, date unknown → assume hot
    if (now - new Date(stamp).getTime() < cooldownMs) out.add(targetSlugFor(i));
  }
  return out;
}

/** The text a collection-gap item should be clustered on. */
export function collectionGapText(item) {
  return item?.signal_source?.keyword
    || item?.proposed_collection?.handle
    || item?.proposed_collection?.title
    || item?.slug
    || '';
}

/**
 * Decide one item.
 *
 * @param {object} item
 * @param {object} ctx
 * @param {Record<string,{status:string,revenue:number,clicks:number,pages:number}>} ctx.clusters
 *        Output of lib/cluster-revenue.js `classifyClusters`, built from
 *        data/reports/seo-impact/latest.json.
 * @param {Set<string>} [ctx.cooldown] target slugs another item recently actioned
 * @param {Map<string,number>} [ctx.productCounts] slug → distinct products matched
 * @returns {{action:'apply'|'dismiss'|'skip', reason:string}}
 */
export function decide(item, { clusters = {}, cooldown = new Set(), productCounts = new Map() } = {}) {
  if (!isKnownSchema(item)) {
    return { action: 'skip', reason: 'unrecognised schema — another producer owns this file; left untouched' };
  }
  if (item.status !== 'pending') {
    return { action: 'skip', reason: `status is "${item.status}", not pending` };
  }

  if (item.trigger === 'collection-gap') {
    // Product-count rule first: it is absolute and needs no revenue data, so a
    // stale or missing seo-impact report can never turn it off.
    const count = productCounts.get(item.slug);
    if (count === undefined) {
      return { action: 'skip', reason: 'could not resolve how many products this collection would hold' };
    }
    if (count < MIN_COLLECTION_PRODUCTS) {
      return {
        action: 'dismiss',
        reason: `only ${count} distinct product${count === 1 ? '' : 's'} match this category — a collection exists only where a category holds ${MIN_COLLECTION_PRODUCTS}+ products (Prime Directive)`,
      };
    }
    const cluster = clusterForText(collectionGapText(item));
    const status = cluster ? clusters?.[cluster]?.status : undefined;
    if (status === 'proven_dud') {
      const c = clusters[cluster];
      return {
        action: 'dismiss',
        reason: `the "${cluster}" cluster has earned $${c.revenue} on ${c.clicks} clicks across ${c.pages} pages — a proven $0 cluster does not get another page (Prime Directive)`,
      };
    }
    return { action: 'skip', reason: 'passes the product-count and revenue gates — creating a page is a human decision, not an auto-apply' };
  }

  if (!AUTO_APPLY_TRIGGERS.has(item.trigger)) {
    return { action: 'skip', reason: `trigger "${item.trigger}" is not in the auto-apply policy` };
  }

  const target = targetSlugFor(item);
  if (cooldown.has(target)) {
    return { action: 'skip', reason: `"${target}" was actioned by another queue item inside the 30-day cooldown` };
  }
  const attempts = Number(item.autoapply?.gate_attempts) || 0;
  if (attempts >= MAX_GATE_ATTEMPTS) {
    return { action: 'skip', reason: `editor gate has failed ${attempts} times — needs a human` };
  }

  return { action: 'apply', reason: `auto-apply trigger "${item.trigger}"` };
}

/**
 * Decide a whole queue and enforce the per-run apply cap.
 *
 * Oldest first: an item that has waited 37 days goes before one filed
 * yesterday, so the backlog drains from the bottom rather than the queue
 * perpetually servicing whatever landed most recently.
 *
 * @returns {{apply:Array, dismiss:Array, skip:Array}} each entry {item, reason}
 */
export function planRun(items, ctx = {}, { cap = MAX_APPLIES_PER_RUN } = {}) {
  const decided = (items || []).map((item) => ({ item, ...decide(item, ctx) }));

  const apply = decided.filter((d) => d.action === 'apply')
    .sort((a, b) => new Date(a.item.created_at || 0) - new Date(b.item.created_at || 0));
  const dismiss = decided.filter((d) => d.action === 'dismiss');
  const skip = decided.filter((d) => d.action === 'skip');

  const capped = apply.slice(cap).map((d) => ({
    ...d,
    action: 'skip',
    reason: `over the per-run cap of ${cap} live applies — will be picked up on the next run`,
  }));

  return {
    apply: apply.slice(0, cap),
    dismiss,
    skip: [...skip, ...capped],
  };
}
