#!/usr/bin/env node
/**
 * Cluster holds — what the fleet is currently NOT spending on, and why.
 *
 * "If it doesn't drive revenue, we put it on hold." A hold pauses unattended
 * refresh/LLM spend on a cluster that earned $0 with a fair shot at traffic. It
 * never unpublishes, deletes, redirects or deindexes anything — every held page
 * stays live and keeps its traffic.
 *
 * A cluster is held only when TWO sources agree it earns nothing: seo-impact's
 * attributed revenue AND real product revenue from the daily Shopify order
 * snapshots. When they disagree the cluster is NOT held and the disagreement is
 * printed as its own section — seo-impact's organic revenue is directional only,
 * and a $0 row beside real orders means attribution is broken for that cluster.
 *
 * A hold nobody can see becomes a mystery outage six weeks later, so this is the
 * one command that answers "why has nothing happened to those posts lately?" —
 * and now also "which clusters is seo-impact getting wrong?".
 *
 * Usage:
 *   npm run cluster-holds
 *   node scripts/cluster-holds.mjs --json
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadClusterHold, HOLD_FLAG, SEO_IMPACT_RELPATH, SHOPIFY_SNAPSHOT_RELDIR, TOP_PRODUCTS_PER_DAY,
} from '../lib/cluster-hold.js';

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
    held: hold.held,
    disagreements: hold.disagreements,
    uncorroborated: hold.uncorroborated,
    corroboration_windows: hold.measured.map((w) => ({
      label: w.label, start: w.start, end: w.end, available: w.available,
      orders: w.orders, revenue: w.revenue, aov: w.aov,
      truncated_days: w.truncatedDays, by_family: w.byFamily,
    })),
    clusters: hold.classified,
  }, null, 2));
  process.exit(0);
}

console.log('\nCluster holds — unattended spend paused on $0 clusters\n');

if (!hold.available) {
  console.log(`  ⚠ ${SEO_IMPACT_RELPATH} is missing or unreadable.`);
  console.log('    Nothing is held. The hold fails OPEN: no measurement, no pause.');
  console.log('    Run `node agents/seo-impact/index.js` (it is gitignored locally — check the server).\n');
  process.exit(0);
}

console.log(`  Attributed revenue: ${SEO_IMPACT_RELPATH} (generated ${hold.generatedAt || 'date unknown'})`);
console.log(`  Real product revenue: ${SHOPIFY_SNAPSHOT_RELDIR} — the corroborating source.`);
for (const w of hold.measured) {
  console.log(`    ${w.label}: ${w.available
    ? `${w.orders} orders / $${(w.revenue || 0).toFixed(2)} — one average order = $${(w.aov || 0).toFixed(2)}`
    : `UNUSABLE (${w.truncatedDays ? `${w.truncatedDays} day(s) at the top-${TOP_PRODUCTS_PER_DAY} collector cap` : 'no orders'})`}`);
}
console.log('\n  A cluster is HELD only when BOTH sources agree it earns nothing.');
console.log('  seo-impact organic revenue is directional only — a disagreement means attribution is broken.');
console.log('  ORDERS $ is per FAMILY, so clusters sharing a family repeat the same figure.\n');

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
console.log(`  ${'CLUSTER'.padEnd(pad)}  ${'FAMILY'.padEnd(fam)}  ${'STATE'.padEnd(9)}  ${'ATTRIB $'.padStart(9)}  ${'ORDERS $'.padStart(9)}  ${'CLICKS'.padStart(7)}  ${'PAGES'.padStart(5)}`);
for (const [cluster, v] of rows) {
  const c = hold.corroborated[cluster] || {};
  const state = LABEL[c.verdict] || c.verdict || '';
  console.log(`  ${cluster.padEnd(pad)}  ${(c.family || '').padEnd(fam)}  ${state.padEnd(9)}`
    + `  ${('$' + (Number(v.revenue) || 0).toFixed(2)).padStart(9)}`
    + `  ${('$' + (Number(c.productRevenue) || 0).toFixed(2)).padStart(9)}`
    + `  ${String(v.clicks).padStart(7)}  ${String(v.pages).padStart(5)}`);
}

// The disagreements are the loud part. A cluster the report calls $0 while real
// orders say otherwise is a broken-attribution finding, not a quiet non-event.
if (hold.disagreements.length) {
  console.log(`\n  ⚠ ATTRIBUTION DISAGREEMENT — ${hold.disagreements.length} cluster(s) NOT held:`);
  for (const d of hold.disagreements) console.log(`      ${d.cluster}: ${d.corroboration}`);
}

if (hold.uncorroborated.length) {
  console.log(`\n  · ${hold.uncorroborated.length} $0-attributed cluster(s) could not be corroborated — NOT held:`);
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
