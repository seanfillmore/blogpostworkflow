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
// TWO SOURCES MUST AGREE, and this is the part that was got wrong first.
//
// `data/reports/seo-impact/latest.json` alone is NOT sufficient evidence for
// this decision. CLAUDE.md and the project memory both record that its
// organic-attributed revenue is UNRELIABLE and directional only, to be
// reconciled against Shopify orders. Held on that source alone, the rule paused
// the soap cluster — which sells $430.70 / 90d, 19% of all revenue and second
// only to lotion. seo-impact filed $62.40 of that under `hand soap` and showed
// `soap` at $0, and the rule read the artifact as a verdict.
//
// So a cluster is held ONLY when BOTH agree it earns nothing:
//
//   1. `lib/cluster-revenue.js`'s `classifyClusters` says `proven_dud`
//      ($0 attributed revenue with ≥100 clicks across ≥5 pages), AND
//   2. measured product revenue for that cluster — real orders, from
//      `data/snapshots/shopify/*.json` `topProducts[]` — is below one average
//      order in EVERY corroboration window.
//
// If they disagree, the cluster is NOT held and the disagreement is reported
// loudly: it means attribution is broken for that cluster, which is a finding
// worth surfacing in its own right, not a detail to swallow.
//
// The two vocabularies meet through `lib/keyword-index/cluster.js`'s ordered
// `assignCluster`, applied to BOTH sides. That is what lets seo-impact's split
// `soap`/`hand soap` rows be compared against product titles that know nothing
// of the split — and its first-match ordering (soap before lotion) is the only
// reason "Moisturizing Coconut Soap" counts as soap revenue.
//
// The classification itself is not re-implemented: `classifyClusters` already
// answers earning / proven_dud / unproven, and a second copy of that threshold
// would drift away from the one the queue and the strategist hold on.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyClusters, clusterForText, provenDuds } from './cluster-revenue.js';
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

/** Daily Shopify order snapshots — the corroborating source. Server-authoritative. */
export const SHOPIFY_SNAPSHOT_RELDIR = join('data', 'snapshots', 'shopify');

/**
 * The second corroboration window, in days, ending where the report's own
 * window ends.
 *
 * The report window is 28 days and carried 18 orders. A category can plausibly
 * sell nothing across 18 orders and still be a real revenue channel, so the
 * report window alone would condemn slow movers. 90 days is the window the
 * revenue reconciliation that caught the soap error was run over.
 */
export const WIDE_WINDOW_DAYS = 90;

/**
 * `agents/shopify-collector`'s `buildTopProducts` keeps only the top 5 products
 * per day. A day at that cap makes the window's product revenue a LOWER BOUND,
 * so a family reading zero might just be the part that was cut — which would
 * make a hold an artifact of the cap rather than a measurement. Such a window is
 * refused. (It has never happened: max 4 across all history.)
 */
export const TOP_PRODUCTS_PER_DAY = 5;

function defaultReadJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function defaultReadDir(path) {
  try { return readdirSync(path); } catch { return []; }
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

function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The windows product revenue is corroborated over, derived from the report's
 * OWN window block so "the same window" is literal rather than a constant that
 * quietly stops matching.
 *
 * Returns [] when the report carries no usable window — corroboration is then
 * impossible and nothing is held.
 */
export function windowsFor(reportWindow) {
  const start = reportWindow?.start;
  const end = reportWindow?.end;
  if (!start || !end) return [];
  const wideStart = shiftDays(end, -(WIDE_WINDOW_DAYS - 1));
  if (!wideStart) return [];
  return [
    { label: `report window (${start} → ${end})`, start, end },
    { label: `wide window (${WIDE_WINDOW_DAYS}d)`, start: wideStart, end },
  ];
}

/**
 * Aggregate daily Shopify snapshots into per-family product revenue.
 *
 * Pure — the caller does the reading, so this is testable against the real
 * product titles without a fixture tree.
 *
 * @param {Array<object>} snapshots
 * @returns {{byFamily:Record<string,number>, titles:Record<string,string[]>,
 *            orders:number, revenue:number, aov:number|null,
 *            days:number, truncatedDays:number, available:boolean}}
 */
export function productRevenueByFamily(snapshots) {
  const byFamily = {}; const titles = {};
  let orders = 0; let revenue = 0; let days = 0; let truncatedDays = 0;

  for (const s of snapshots || []) {
    if (!s || typeof s !== 'object') continue;
    days += 1;
    orders += Number(s.orders?.count) || 0;
    revenue += Number(s.orders?.revenue) || 0;
    const products = Array.isArray(s.topProducts) ? s.topProducts : [];
    if (products.length >= TOP_PRODUCTS_PER_DAY) truncatedDays += 1;
    for (const p of products) {
      const family = clusterFamily(p?.title);
      if (family === 'unclustered') continue;
      byFamily[family] = round2((byFamily[family] || 0) + (Number(p?.revenue) || 0));
      (titles[family] ||= []).includes(p.title) || titles[family].push(p.title);
    }
  }

  // No orders → no average order → no floor to compare against. A truncated day
  // makes the whole window a lower bound. Either way: not evidence.
  const available = orders > 0 && truncatedDays === 0;
  return {
    byFamily, titles, orders, revenue: round2(revenue), days, truncatedDays, available,
    aov: orders > 0 ? revenue / orders : null,
  };
}

/**
 * The corroboration verdict for every cluster in the report.
 *
 * @param {Record<string,{status:string}>} classified  from classifyClusters
 * @param {Array<object>} measured  one entry per window, from productRevenueByFamily
 * @returns {Record<string,{verdict:'held'|'disagreement'|'uncorroborated'|'earning'|'unproven',
 *                          family:string, reason:string|null, productRevenue:number}>}
 */
export function corroborateClusters(classified, measured) {
  const out = {};
  const usableWindows = (measured || []).filter((w) => w?.available);

  /**
   * Highest measured revenue for a family across the windows.
   *
   * Computed for EVERY cluster, not just the duds — an operator reading the
   * table needs to see attributed-vs-real on the earning rows too, since that
   * comparison is what exposes an attribution split (one cluster catching a
   * fraction of a family's real revenue while its sibling shows $0). The figure
   * is per FAMILY, so sibling clusters legitimately repeat it.
   */
  const realRevenue = (family) => (family === 'unclustered' || !usableWindows.length
    ? 0
    : round2(Math.max(...usableWindows.map((w) => Number(w.byFamily?.[family]) || 0))));

  for (const [cluster, stats] of Object.entries(classified || {})) {
    const fam = clusterFamily(cluster);
    if (stats.status !== 'proven_dud') {
      out[cluster] = { verdict: stats.status, family: fam, reason: null, productRevenue: realRevenue(fam) };
      continue;
    }

    const family = fam;
    if (family === 'unclustered') {
      out[cluster] = {
        verdict: 'uncorroborated', family, productRevenue: 0,
        reason: `"${cluster}" could not be mapped to a product family, so its $0 cannot be checked against real orders — not held`,
      };
      continue;
    }

    const usable = usableWindows;
    if (!usable.length) {
      out[cluster] = {
        verdict: 'uncorroborated', family, productRevenue: 0,
        reason: 'no usable Shopify order snapshots to corroborate against — not held',
      };
      continue;
    }

    // Unanimity: ONE window showing material revenue blocks the hold. Errors
    // here must fall toward not-holding, which is what the soap case taught.
    const material = usable
      .map((w) => ({ w, rev: Number(w.byFamily?.[family]) || 0 }))
      .filter(({ w, rev }) => rev >= w.aov);

    const maxRev = Math.max(...usable.map((w) => Number(w.byFamily?.[family]) || 0));

    if (material.length) {
      const detail = material
        .map(({ w, rev }) => `$${round2(rev)} in the ${w.label} (one average order is $${round2(w.aov)})`)
        .join('; ');
      out[cluster] = {
        verdict: 'disagreement', family, productRevenue: round2(maxRev),
        reason: `ATTRIBUTION DISAGREEMENT — seo-impact attributes $0 to "${cluster}", but the "${family}" `
          + `products really sold ${detail}. NOT held. Two sources disagreeing means attribution is broken `
          + 'for this cluster, which is the thing to fix.',
      };
      continue;
    }

    const detail = usable
      .map((w) => `$${round2(Number(w.byFamily?.[family]) || 0)} over the ${w.label}`)
      .join(', ');
    out[cluster] = {
      verdict: 'held', family, productRevenue: round2(maxRev),
      reason: `corroborated: real orders show ${detail} — below one average order in every window`,
    };
  }
  return out;
}

/**
 * Build a hold context from an already-classified cluster map.
 *
 * @param {Record<string,{status:string,revenue:number,clicks:number,pages:number}>} classified
 * @returns {{classified:object, held:Array, heldSet:Set<string>, available:boolean,
 *            generatedAt:string|null, source:string|null}}
 */
export function buildClusterHold(classified, {
  available = true, generatedAt = null, source = null, measured = [],
  stale = false, freshness = null,
} = {}) {
  const corroborated = corroborateClusters(classified, measured);
  const duds = provenDuds(classified);

  const held = []; const disagreements = []; const uncorroborated = [];
  for (const dud of duds) {
    const c = corroborated[dud.cluster] || {};
    const row = { ...dud, family: c.family, productRevenue: c.productRevenue || 0, corroboration: c.reason };
    if (c.verdict === 'held') held.push(row);
    else if (c.verdict === 'disagreement') disagreements.push(row);
    else uncorroborated.push(row);
  }

  return {
    classified: classified || {},
    corroborated,
    measured,
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
 * `totals` block (PR #624) — one more input the gate refuses to guess at, not a
 * second mechanism beside it.
 *
 * `today` is injectable for the same reason `readJson` is: so the freshness
 * boundary is testable without touching the clock.
 */
export function loadClusterHold({
  root = process.cwd(), readJson = defaultReadJson, readDir = defaultReadDir, today = todayPT(),
} = {}) {
  const source = join(root, SEO_IMPACT_RELPATH);
  const impact = readJson(source);
  // Freshness comes from the report OBJECT, not a second read of the path — a
  // re-read would bypass the injected `readJson` and make this untestable
  // without a fixture on disk.
  const freshness = freshnessOfReport(impact, { today });
  const stale = freshness.status === 'stale';
  const usable = !!impact && !stale;

  const measured = loadMeasuredRevenue({ root, readJson, readDir, reportWindow: impact?.window });
  // `totals` is not optional garnish: without the window's own organic order
  // count, `classifyClusters` cannot tell a genuinely dead cluster from a window
  // too thin (or too broken) to judge, and refuses to call anything a dud.
  return buildClusterHold(classifyClusters(usable ? (impact.clusters || []) : [], {
    totals: usable ? impact.totals : null,
  }), {
    available: usable,
    stale,
    freshness,
    generatedAt: impact?.generated_at || null,
    source,
    measured,
  });
}

/**
 * Read the daily Shopify snapshots once and aggregate them into every
 * corroboration window.
 *
 * Only files inside a window are read — a full history is ~200 files and the
 * unattended agents call this on every run.
 */
export function loadMeasuredRevenue({
  root = process.cwd(), readJson = defaultReadJson, readDir = defaultReadDir, reportWindow,
} = {}) {
  const windows = windowsFor(reportWindow);
  if (!windows.length) return [];

  const dir = join(root, SHOPIFY_SNAPSHOT_RELDIR);
  const earliest = windows.reduce((min, w) => (w.start < min ? w.start : min), windows[0].start);
  const latest = windows.reduce((max, w) => (w.end > max ? w.end : max), windows[0].end);

  const byDate = new Map();
  for (const file of readDir(dir)) {
    if (!file.endsWith('.json')) continue;
    const date = file.slice(0, -5);
    if (date < earliest || date > latest) continue;
    const snap = readJson(join(dir, file));
    if (snap) byDate.set(date, snap);
  }

  return windows.map((w) => {
    const inWindow = [...byDate.entries()]
      .filter(([date]) => date >= w.start && date <= w.end)
      .map(([, snap]) => snap);
    return { ...w, ...productRevenueByFamily(inWindow) };
  });
}

/**
 * The classification, with every UNCORROBORATED `proven_dud` downgraded to
 * `unproven`. This is what anything that BLOCKS or DELETES work must read.
 *
 * `classifyClusters` answers one question — does seo-impact attribute this
 * cluster $0 on enough traffic to matter? — from one directional source. That
 * verdict is enough to pause unattended spend (this module's original job), and
 * it is NOT enough to drop an LLM's proposal, defer a calendar item by 30 days,
 * or `unlinkSync` a paid-for brief. Those three consumers were reading the raw
 * classification, so on 2026-08-22 the `soap` cluster — ~$430/90d, 19% of all
 * revenue, with a paid giveaway campaign live — was silently blocked from
 * content and had its briefs marked for deletion, on an attribution artifact.
 *
 * A deletion path must be at least as evidence-hungry as a spend pause, so it
 * gets the same two-source rule: $0 attributed AND real Shopify product revenue
 * below one average order in EVERY corroboration window. A disagreement, a
 * cluster that maps to no product family, and a missing snapshot tree all
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
    `⚠ ATTRIBUTION DISAGREEMENT — ${hold.disagreements.length} cluster(s) attributed $0 by seo-impact are really earning; NOT held:`,
    ...hold.disagreements.map((d) => `  ${d.cluster}: seo-impact $0 vs $${round2(d.productRevenue)} in real orders (as "${d.family}" products)`),
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

  if (hold.held.length) {
    lines.push(`  ${hold.held.length} cluster(s) ON HOLD (measured ${hold.generatedAt || 'date unknown'}) — pages stay live, spend is paused:`);
    for (const h of hold.held) {
      lines.push(`      ${h.cluster}: $${(Number(h.revenue) || 0).toFixed(2)} attributed on ${h.clicks} clicks / ${h.pages} pages`
        + `; real orders $${round2(h.productRevenue)} — both sources agree`);
    }
    lines.push(`      override with ${HOLD_FLAG}; list with \`npm run cluster-holds\``);
  }

  // Loud on purpose, and never folded into the hold list. A cluster the report
  // calls $0 while the orders say otherwise is a broken-attribution finding —
  // exactly the defect that made this rule pause a category earning 19% of
  // revenue. It must not read as a quiet "not held".
  if (hold.disagreements?.length) {
    lines.push(`  ⚠ ATTRIBUTION DISAGREEMENT on ${hold.disagreements.length} cluster(s) — NOT held, and worth fixing:`);
    for (const d of hold.disagreements) {
      lines.push(`      ${d.cluster}: seo-impact says $0, real orders say $${round2(d.productRevenue)} `
        + `(as "${d.family}" products). seo-impact organic revenue is directional only — the orders win.`);
    }
  }

  if (hold.uncorroborated?.length) {
    lines.push(`  · ${hold.uncorroborated.length} $0-attributed cluster(s) could not be corroborated against orders — NOT held:`);
    for (const u of hold.uncorroborated) lines.push(`      ${u.cluster}: ${u.corroboration}`);
  }

  return lines.join('\n');
}
