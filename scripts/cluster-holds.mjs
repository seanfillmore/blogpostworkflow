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
 * Usage:
 *   npm run cluster-holds
 *   node scripts/cluster-holds.mjs --json
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadClusterHold, HOLD_FLAG, SEO_IMPACT_RELPATH, WIDE_WINDOW_DAYS,
} from '../lib/cluster-hold.js';
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
  ['queue-autoapply', 'collection-gap dismissal (pre-existing, same evidence)'],
];

const hold = loadClusterHold({ root: ROOT });

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

console.log(`\n  ${hold.held.length} cluster(s) on hold.`);
if (hold.held.length) {
  for (const h of hold.held) console.log(`      ${h.cluster}: ${h.corroboration}`);
  console.log('\n  Those pages remain LIVE and INDEXED. Only unattended spend is paused.\n');
  console.log('  Agents that honour the hold:');
  for (const [agent, what] of GATED) console.log(`    ${agent.padEnd(22)} ${what}`);
  console.log(`\n  Override on any of them: add ${HOLD_FLAG} to the run.`);
  console.log('  A cluster releases itself automatically the moment it earns a dollar.\n');
} else {
  console.log('  No cluster currently qualifies. Every agent runs its full pick list.\n');
}
