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
// NO CLUSTER IS NAMED HERE. The held set is derived from measured revenue in
// data/reports/seo-impact/latest.json, exactly as `lib/queue-autoapply.js`'s
// $0-cluster dismissal already does, so the rule generalises to whatever goes
// to $0 next — and RELEASES a cluster automatically the moment it earns a
// dollar. A hardcoded blocklist would do neither.
//
// The classification itself is not re-implemented: `lib/cluster-revenue.js`'s
// `classifyClusters` already answers earning / proven_dud / unproven on the same
// report, and a second copy of that threshold would drift away from the one the
// queue and the strategist hold on. HELD == `proven_dud`, and that is the whole
// definition.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyClusters, clusterForText, provenDuds } from './cluster-revenue.js';

/** The operator's escape hatch, spelled the same way by every agent. */
export const HOLD_FLAG = '--include-held';

/** The one report every agent holds on. One path, so nobody holds on a different truth. */
export const SEO_IMPACT_RELPATH = join('data', 'reports', 'seo-impact', 'latest.json');

function defaultReadJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Build a hold context from an already-classified cluster map.
 *
 * @param {Record<string,{status:string,revenue:number,clicks:number,pages:number}>} classified
 * @returns {{classified:object, held:Array, heldSet:Set<string>, available:boolean,
 *            generatedAt:string|null, source:string|null}}
 */
export function buildClusterHold(classified, { available = true, generatedAt = null, source = null } = {}) {
  const held = provenDuds(classified);
  return {
    classified: classified || {},
    held,
    heldSet: new Set(held.map((h) => h.cluster)),
    available,
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
 */
export function loadClusterHold({ root = process.cwd(), readJson = defaultReadJson } = {}) {
  const source = join(root, SEO_IMPACT_RELPATH);
  const impact = readJson(source);
  return buildClusterHold(classifyClusters(impact?.clusters || []), {
    available: !!impact,
    generatedAt: impact?.generated_at || null,
    source,
  });
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

/** The sentence an agent logs and puts in the digest. Says what a hold is and is not. */
export function holdReason(cluster, stats = {}) {
  const revenue = Number(stats.revenue) || 0;
  const clicks = Number(stats.clicks) || 0;
  const pages = Number(stats.pages) || 0;
  return `the "${cluster}" cluster is ON HOLD — $${revenue.toFixed(2)} revenue on ${clicks} clicks `
    + `across ${pages} pages. Unattended refresh/LLM spend is paused until it earns (Prime Directive). `
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
 * The startup banner: what is currently held, and on what evidence. Printed by
 * every gated agent so a hold is never invisible.
 *
 * Returns '' when nothing is held AND the report was readable — the only silent
 * case, and the normal one.
 */
export function holdBanner(hold) {
  if (!hold) return '';
  if (!hold.available) {
    return `  ⚠ ${SEO_IMPACT_RELPATH} is missing — the $0-cluster hold cannot fire this run. `
      + 'Nothing is paused on a guess; run agents/seo-impact to restore it.';
  }
  if (!hold.held.length) return '';
  const rows = hold.held.map((h) => `      ${h.cluster}: $${(Number(h.revenue) || 0).toFixed(2)} on ${h.clicks} clicks / ${h.pages} pages`);
  return [
    `  ${hold.held.length} cluster(s) ON HOLD (measured ${hold.generatedAt || 'date unknown'}) — pages stay live, spend is paused:`,
    ...rows,
    `      override with ${HOLD_FLAG}; list with \`npm run cluster-holds\``,
  ].join('\n');
}
