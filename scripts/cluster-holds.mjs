#!/usr/bin/env node
/**
 * Cluster holds — what the fleet is currently NOT spending on, and why.
 *
 * "If it doesn't drive revenue, we put it on hold." A hold pauses unattended
 * refresh/LLM spend on a cluster that earned $0 with a fair shot at traffic. It
 * never unpublishes, deletes, redirects or deindexes anything — every held page
 * stays live and keeps its traffic.
 *
 * A hold nobody can see becomes a mystery outage six weeks later, so this is the
 * one command that answers "why has nothing happened to those posts lately?".
 *
 * Usage:
 *   npm run cluster-holds
 *   node scripts/cluster-holds.mjs --json
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClusterHold, HOLD_FLAG, SEO_IMPACT_RELPATH } from '../lib/cluster-hold.js';

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

console.log(`  Evidence: ${SEO_IMPACT_RELPATH} (generated ${hold.generatedAt || 'date unknown'})`);
console.log('  Held = earned $0 with enough traffic across enough pages to count as evidence.\n');

const rows = Object.entries(hold.classified)
  .sort((a, b) => (b[1].clicks || 0) - (a[1].clicks || 0));

if (!rows.length) {
  console.log('  The report contains no clusters.\n');
  process.exit(0);
}

const pad = Math.max(...rows.map(([c]) => c.length), 7);
console.log(`  ${'CLUSTER'.padEnd(pad)}  ${'STATUS'.padEnd(11)}  ${'REVENUE'.padStart(9)}  ${'CLICKS'.padStart(7)}  ${'PAGES'.padStart(5)}`);
for (const [cluster, v] of rows) {
  const status = v.status === 'proven_dud' ? 'ON HOLD' : v.status;
  console.log(`  ${cluster.padEnd(pad)}  ${status.padEnd(11)}  ${('$' + (Number(v.revenue) || 0).toFixed(2)).padStart(9)}  ${String(v.clicks).padStart(7)}  ${String(v.pages).padStart(5)}`);
}

console.log(`\n  ${hold.held.length} cluster(s) on hold.`);
if (hold.held.length) {
  console.log('  Those pages remain LIVE and INDEXED. Only unattended spend is paused.\n');
  console.log('  Agents that honour the hold:');
  for (const [agent, what] of GATED) console.log(`    ${agent.padEnd(22)} ${what}`);
  console.log(`\n  Override on any of them: add ${HOLD_FLAG} to the run.`);
  console.log('  A cluster releases itself automatically the moment it earns a dollar.\n');
} else {
  console.log('  No cluster currently qualifies. Every agent runs its full pick list.\n');
}
