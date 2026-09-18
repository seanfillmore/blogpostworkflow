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
import { checkSeoCopyFields } from './seo-copy-health-gate.js';

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
 * The skips that will NEVER clear on their own, and what a human has to decide.
 *
 * `decide()` returns `action: 'skip'` for several reasons and they are NOT
 * alike. Most clear themselves: a 30-day cooldown expires, an over-cap item is
 * picked up on the next run, an unresolvable product count resolves when
 * Shopify comes back. These four do not — no automated run will ever change the
 * verdict, and the item stays `pending` forever.
 *
 * The distinction was invisible before: every one of them landed in the same
 * `skipped[]` array, so "waiting for a cooldown" and "the robot has given up"
 * read identically. The worst case is an item that TRANSITIONS — while
 * `gate_attempts < 3` it sits in `gated[]`, which the digest describes as
 * "stays pending for the repair loop"; at 3 it moves into `skipped[]` with no
 * field change at all, from "the loop owns this" to "nobody owns this".
 *
 * Sean, on what should reach him: "That should surface as a decision that needs
 * to be made by me." Note what that does NOT license — this is not the
 * Optimization Queue coming back. A routine item the fleet will apply tomorrow
 * is never a decision; only an item automation has permanently abandoned is.
 * Measured on production 2026-09-18 that is ONE item of four pending, which is
 * what makes it appropriate for the digest at all.
 *
 * Deliberately NOT here: `unrecognised schema` (a pdp-builder artifact —
 * permanent, but that producer's business, not a queue decision) and every
 * `dismiss`, which is a verdict already reached rather than one awaiting a human.
 */
export const DECISION_LABELS = Object.freeze({
  'editor-gate-exhausted': 'The editor gate failed 3 times — rewrite it, or write it off',
  'health-claim': 'Stored copy trips the health-claim gate and cannot be regenerated here — re-run the producing agent, or edit by hand',
  'create-page': 'Passes the product-count and revenue gates — creating a commercial page is your call',
  'not-auto-appliable': 'This trigger is outside the auto-apply policy — it will never ship on its own',
});

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

/**
 * The copy-facing fields a queue item carries INLINE, keyed by the name a human
 * should see in the digest.
 *
 * Only inline strings. Two kinds of body are deliberately absent:
 *
 *   - **File-backed bodies** (`refreshed_html_path`, `proposed_html_path`).
 *     Reading them is I/O and this module is pure — that purity is what lets
 *     `decide()` run the gate before a single model call is spent. The
 *     collection body behind `proposed_html_path` is gated by its own producer,
 *     `agents/collection-content-optimizer --publish-approved`, which is the
 *     only thing that publishes it.
 *   - **Article bodies.** A refreshed blog post is editorial, not the product
 *     speaking, and the blocking vocabulary legitimately appears in it — a post
 *     about sensitive skin says "eczema" because that is what the reader typed.
 *     Those go through `lib/edit-gate-repair.js`, a different gate asking a
 *     different question. Extending the health gate over 1,500-word article
 *     bodies is a separate change with its own blast radius; measuring one and
 *     shipping the other is how a safety fix becomes an outage.
 *
 * @returns {Record<string,string>} empty when the item carries no inline copy
 */
export function seoCopyFieldsForItem(item) {
  const out = {};
  const put = (name, value) => { if (String(value ?? '').trim()) out[name] = value; };

  put('collection title', item?.proposed_collection?.title);
  put('product title', item?.proposed_title?.new_title);
  put('meta title_tag', item?.proposed_meta?.seo_title ?? item?.proposed_collection?.seo_title);
  put('meta description_tag', item?.proposed_meta?.seo_description ?? item?.proposed_collection?.seo_description);
  put('page summary', item?.proposed_meta?.summary);
  put('product body', item?.proposed_body_html);
  put('collection body', item?.proposed_collection?.body_html);

  return out;
}

/**
 * The blocking-tier health-claim hits in an item's stored copy, or `null`.
 * Pure and free (regexes only), which is why it is safe to re-run on every
 * daily pass rather than needing an attempt counter to bound its cost.
 */
export function seoCopyViolationsForItem(item) {
  const fields = seoCopyFieldsForItem(item);
  if (!Object.keys(fields).length) return null;
  const check = checkSeoCopyFields(fields);
  return check.ok ? null : check.blocking;
}

/** A one-line, digest-ready reason naming field and word. */
export function healthClaimSkipReason(violations) {
  const words = [...new Set(violations.map((v) => `${v.field}: "${v.match}"`))].join(', ');
  return `health-claim gate: the stored copy makes a claim a cosmetic may not make (${words}). `
    + 'This layer applies copy generated by an earlier run and cannot regenerate it, so the write is '
    + 'refused and the item is left pending — re-run the producing agent or edit it by hand.';
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
    // A collection-gap never auto-applies, but the dashboard's Approve button
    // can push it live through the same lib/queue-apply.js. Saying so in the
    // daily report is how the claim becomes visible before someone clicks.
    const gapClaims = seoCopyViolationsForItem(item);
    if (gapClaims) return { action: 'skip', gate: 'health-claim', decision: 'health-claim', violations: gapClaims, reason: healthClaimSkipReason(gapClaims) };
    return { action: 'skip', decision: 'create-page', reason: 'passes the product-count and revenue gates — creating a page is a human decision, not an auto-apply' };
  }

  if (!AUTO_APPLY_TRIGGERS.has(item.trigger)) {
    return { action: 'skip', decision: 'not-auto-appliable', reason: `trigger "${item.trigger}" is not in the auto-apply policy` };
  }

  // ── health-claim gate ───────────────────────────────────────────────────────
  // BEFORE the cooldown check, the gate-attempt counter and — crucially — before
  // the caller spends anything: the editor gate, its repair loop and the Shopify
  // write all happen after `planRun`. Same reason lib/cluster-hold.js is applied
  // before the per-run cap: a gated item that reached the apply list would eat
  // one of five daily slots and produce nothing.
  //
  // SKIP, never dismiss. This layer cannot regenerate — there is no prompt here
  // — so refusing the write is the only safe action, and deciding the item is
  // worthless is not this gate's call to make. It stays pending, is named in the
  // report and in the digest, and costs nothing to re-check tomorrow.
  const claims = seoCopyViolationsForItem(item);
  if (claims) {
    return { action: 'skip', gate: 'health-claim', decision: 'health-claim', violations: claims, reason: healthClaimSkipReason(claims) };
  }

  const target = targetSlugFor(item);
  if (cooldown.has(target)) {
    return { action: 'skip', reason: `"${target}" was actioned by another queue item inside the 30-day cooldown` };
  }
  const attempts = Number(item.autoapply?.gate_attempts) || 0;
  if (attempts >= MAX_GATE_ATTEMPTS) {
    return { action: 'skip', decision: 'editor-gate-exhausted', reason: `editor gate has failed ${attempts} times — needs a human` };
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

  const allSkips = [...skip, ...capped];

  return {
    apply: apply.slice(0, cap),
    dismiss,
    skip: allSkips,
    // The skips no automated run will ever clear. Everything else in `skip`
    // resolves on its own (a cooldown expires, the cap frees up, Shopify comes
    // back), so surfacing the whole list would rebuild the to-do list the digest
    // deliberately stopped printing.
    decisions: allSkips.filter((d) => d.decision),
  };
}
