#!/usr/bin/env node
/**
 * Cluster holds — what the fleet is currently NOT spending on, and why.
 *
 * "If it doesn't drive revenue, we put it on hold." A hold pauses unattended
 * refresh/LLM spend on a cluster that earned $0 with a fair shot at traffic. It
 * never unpublishes, deletes, redirects or deindexes anything — every held page
 * stays live and keeps its traffic.
 *
 * A cluster is held only when TWO sources agree it earns nothing, both read over
 * the 90-day judging window: what the category's PRODUCTS sold (order line items,
 * keyed on product title) AND what its PAGES earned (order totals, keyed on the
 * landing-page URL). When they disagree the cluster is NOT held and the
 * disagreement is printed as its own section — either attribution is broken for
 * that cluster, or its pages are selling somebody else's category.
 *
 * A hold nobody can see becomes a mystery outage six weeks later, so this is the
 * one command that answers "why has nothing happened to those posts lately?" —
 * and now also "which clusters is the fleet getting wrong?".
 *
 * IT ALSO PRINTS THE EFFICIENCY RANKING, because on this store a hold is now a
 * rare event and the ranking is what actually decides where the budget goes on
 * an ordinary day. Same file, same window, same command: an operator asking "why
 * did toothpaste not get touched again?" needs one place to look, and splitting
 * hold and rank across two commands is how the second one stops being read.
 *
 * Usage:
 *   npm run cluster-holds
 *   node scripts/cluster-holds.mjs --json
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadClusterHold, HOLD_FLAG, SEO_IMPACT_RELPATH, WIDE_WINDOW_DAYS,
} from '../lib/cluster-hold.js';
import { rankClusters, RESERVE_MIN_LIMIT } from '../lib/cluster-efficiency.js';
import { staleNote } from '../lib/seo-impact-freshness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every agent that consults the hold, and the pick list it applies it to. Kept
// here rather than in a doc because this is what an operator reads first.
const GATED = [
  ['indexing-fixer', 'crawled_not_indexed → content-quality refresh'],
  ['performance-engine', 'flop / quick-win / low-CTR-meta / legacy-flop picks'],
  ['legacy-rebuilder', 'legacy + needs_rebuild pick list'],
  ['blocked-post-resolver', 'hard-blocked post candidates'],
  ['refresh-runner', '--from-post-performance / --from-quick-wins / --aging-quarterly'],
  ['meta-optimizer', 'low-CTR candidate list (weekly --apply --limit 5)'],
  ['queue-autoapply', 'collection-gap dismissal (pre-existing, same evidence)'],
];

// Which of those ALSO order their pick list by efficiency, and which do not.
// `indexing-fixer` is the deliberate omission: its content-quality list has no
// per-run cap, so every actionable post is refreshed whatever order it is in and
// ranking there would be code that changes nothing. `queue-autoapply` drains
// oldest-first on purpose — that IS its anti-starvation policy, and it applies
// work another agent already decided to do.
const RANKED = new Set([
  'performance-engine', 'legacy-rebuilder', 'blocked-post-resolver',
  'refresh-runner', 'meta-optimizer',
]);

const hold = loadClusterHold({ root: ROOT });
const ranking = rankClusters(hold);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    generated_at: hold.generatedAt,
    source: SEO_IMPACT_RELPATH,
    available: hold.available,
    stale: hold.stale,
    freshness: hold.freshness,
    held: hold.held,
    disagreements: hold.disagreements,
    uncorroborated: hold.uncorroborated,
    judging_window: hold.judgingWindow,
    judging_window_orders: hold.windowOrders,
    clusters: hold.classified,
    efficiency: {
      available: ranking.available,
      reason: ranking.reason,
      prior_clicks: ranking.priorClicks,
      reserve_min_limit: RESERVE_MIN_LIMIT,
      reserve_cluster: ranking.reserveCluster,
      total_revenue: ranking.totalRevenue,
      total_clicks: ranking.totalClicks,
      ordered: ranking.ordered,
    },
  }, null, 2));
  process.exit(0);
}

console.log('\nCluster holds — unattended spend paused on $0 clusters\n');

if (!hold.available) {
  // Stale and absent both fail open, but they are different things to go and
  // fix: one means the file never arrived, the other means the producer stopped.
  console.log(hold.stale
    ? `  ⚠ ${staleNote(hold.freshness)}`
    : `  ⚠ ${SEO_IMPACT_RELPATH} is missing or unreadable.`);
  console.log('    Nothing is held. The hold fails OPEN: no usable measurement, no pause.');
  console.log('    Run `node agents/seo-impact/index.js` (it is gitignored locally — check the server).\n');
  process.exit(0);
}

console.log(`  Source: ${SEO_IMPACT_RELPATH} (generated ${hold.generatedAt || 'date unknown'})`);
console.log(`  Judging window: ${hold.judgingWindow
  ? `${hold.judgingWindow.start} → ${hold.judgingWindow.end}`
  : `${WIDE_WINDOW_DAYS}d (dates not recorded)`}`
  + `${hold.windowOrders == null ? ' — order count MISSING, so nothing can be held' : `, ${hold.windowOrders} all-channel orders`}`);
console.log('\n  A cluster is HELD only when BOTH sources agree it earns nothing:');
console.log('    SOLD $   what the category\'s PRODUCTS sold  (line items, keyed on product title, all channels)');
console.log('    PAGES $  what its PAGES earned              (order totals, keyed on landing-page URL, organic)');
console.log('  Either one above $0 blocks the hold. PAGES $ is per FAMILY, so clusters sharing a family repeat it.');
console.log('  ENTRY 28d is the report\'s own narrow-window figure — shown for context, judged on by nothing.\n');

const rows = Object.entries(hold.classified)
  .sort((a, b) => (b[1].clicks || 0) - (a[1].clicks || 0));

if (!rows.length) {
  console.log('  The report contains no clusters.\n');
  process.exit(0);
}

const LABEL = {
  held: 'ON HOLD', disagreement: 'DISAGREE!', uncorroborated: 'no data',
};
const pad = Math.max(...rows.map(([c]) => c.length), 7);
const fam = Math.max(...rows.map(([c]) => (hold.corroborated[c]?.family || '').length), 6);
const money = (n) => (n == null ? '     —' : `$${(Number(n) || 0).toFixed(2)}`);
console.log(`  ${'CLUSTER'.padEnd(pad)}  ${'FAMILY'.padEnd(fam)}  ${'STATE'.padEnd(9)}  ${'SOLD $'.padStart(9)}  ${'PAGES $'.padStart(9)}  ${'ENTRY 28d'.padStart(9)}  ${'CLICKS'.padStart(7)}  ${'PAGES'.padStart(5)}`);
for (const [cluster, v] of rows) {
  const c = hold.corroborated[cluster] || {};
  const state = LABEL[c.verdict] || c.verdict || '';
  console.log(`  ${cluster.padEnd(pad)}  ${(c.family || '').padEnd(fam)}  ${state.padEnd(9)}`
    + `  ${money(v.productRevenue).padStart(9)}`
    + `  ${money(c.entryPageRevenue).padStart(9)}`
    + `  ${money(v.revenue).padStart(9)}`
    + `  ${String(v.clicks).padStart(7)}  ${String(v.pages).padStart(5)}`);
}

// The disagreements are the loud part. A category whose products sold nothing
// while its pages earn is either broken attribution or a cluster with no SKU
// behind it — a finding either way, not a quiet non-event.
if (hold.disagreements.length) {
  console.log(`\n  ⚠ SOURCES DISAGREE — ${hold.disagreements.length} cluster(s) NOT held:`);
  for (const d of hold.disagreements) console.log(`      ${d.cluster}: ${d.corroboration}`);
}

if (hold.uncorroborated.length) {
  console.log(`\n  · ${hold.uncorroborated.length} cluster(s) sold $0 but could not be cross-checked — NOT held:`);
  for (const u of hold.uncorroborated) console.log(`      ${u.cluster}: ${u.corroboration}`);
}

// ── efficiency ranking ───────────────────────────────────────────────────────
// The softer intervention, and on this store the one that actually fires. A hold
// EXCLUDES a cluster; this ORDERS what is left, so the categories that convert
// are reached before the ones that merely rank.
console.log('\n  EFFICIENCY RANKING — the order agents spend their per-run caps in.');
if (!ranking.available) {
  console.log(`    ⚠ Not ranked this run: ${ranking.reason}`);
  console.log('    Every gated agent keeps whatever order its own picker produced. Nothing is blocked.\n');
} else {
  console.log(`    SCORE = SOLD $ ÷ (clicks + ${ranking.priorClicks} pseudo-clicks). The pseudo-clicks are the`);
  console.log('    fair-shot bar (lib/cluster-revenue.js MIN_CLICKS): they stop a cluster with a handful of');
  console.log('    clicks looking wildly efficient on a sample too small to mean anything. It shrinks toward');
  console.log('    ZERO, never toward the site average — a category measured at $0 across every order in the');
  console.log('    window must not be flattered back up to "probably average".');
  console.log('    SCORE is an INDEX for comparing clusters on THIS report (90d all-channel $ over 28d organic');
  console.log('    clicks). It is not dollars per click and does not survive a change of window.');
  console.log('    $/PAGE is shown because page counts differ hugely; nothing sorts on it — pages are a');
  console.log('    decision we made, clicks are demand the cluster actually attracted.\n');
  const rpad = Math.max(...ranking.ordered.map((e) => e.cluster.length), 7);
  console.log(`    ${'#'.padStart(2)}  ${'CLUSTER'.padEnd(rpad)}  ${'SCORE'.padStart(8)}  ${'SOLD $'.padStart(9)}  ${'CLICKS'.padStart(7)}  ${'%CLICKS'.padStart(7)}  ${'%REV'.padStart(6)}  ${'RAW $/CLK'.padStart(9)}  ${'$/PAGE'.padStart(7)}`);
  for (const e of ranking.ordered) {
    const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');
    console.log(`    ${String(e.rank + 1).padStart(2)}  ${e.cluster.padEnd(rpad)}  ${e.score.toFixed(4).padStart(8)}`
      + `  ${`$${e.productRevenue.toFixed(2)}`.padStart(9)}  ${String(e.clicks).padStart(7)}`
      + `  ${pct(e.clicks, ranking.totalClicks).padStart(7)}  ${pct(e.productRevenue, ranking.totalRevenue).padStart(6)}`
      + `  ${(e.revenuePerClick == null ? '—' : `$${e.revenuePerClick.toFixed(2)}`).padStart(9)}`
      + `  ${(e.revenuePerPage == null ? '—' : `$${e.revenuePerPage.toFixed(2)}`).padStart(7)}`
      + `${e.held ? '   [ON HOLD]' : ''}`);
  }
  console.log('\n    NOTHING IS BLOCKED BY THIS ORDER. Where an agent has a per-run cap of at least');
  console.log(`    ${RESERVE_MIN_LIMIT}, one slot inside that cap is RESERVED for the lowest-ranked cluster in the pick`);
  console.log('    list, so a ranking can never starve a cluster to zero the way a hard block would.');
  console.log(`    Reserve target when every cluster is in play: ${ranking.reserveCluster || '(none — too few clusters)'}.`);
  console.log('    A held cluster is NEVER the reserve target; that would undo the hold.');
}

console.log(`\n  ${hold.held.length} cluster(s) on hold.`);
if (hold.held.length) {
  for (const h of hold.held) console.log(`      ${h.cluster}: ${h.corroboration}`);
  console.log('\n  Those pages remain LIVE and INDEXED. Only unattended spend is paused.');
  console.log('  A cluster releases itself automatically the moment it earns a dollar.');
} else {
  console.log('  No cluster currently qualifies — no cluster is EXCLUDED from any pick list.');
  console.log('  That is the usual state and it is why the ranking above matters more than this line:');
  console.log('  at ~50 orders / 90 days this store can rarely condemn a category on revenue evidence.');
}

console.log('\n  Agents that consult this report, and what each one does with it:');
for (const [agent, what] of GATED) {
  console.log(`    ${agent.padEnd(22)} ${RANKED.has(agent) ? 'hold + rank' : 'hold only  '}  ${what}`);
}
console.log('    indexing-fixer is hold-only on purpose: its content-quality list has no per-run cap,');
console.log('    so every actionable post is refreshed whatever order it is in.');
console.log('    queue-autoapply is hold-only on purpose: it drains oldest-first, which is already an');
console.log('    anti-starvation policy, over work another agent has already decided to do.');
console.log(`\n  Override the HOLD on any of them: add ${HOLD_FLAG} to the run. There is no flag to`);
console.log('  override the RANKING, because it excludes nothing — it only decides what comes first.\n');
