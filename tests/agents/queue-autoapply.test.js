import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { buildProductCounts } from '../../agents/queue-autoapply/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The import above is itself the assertion for the guard: importing an agent
// must not run it. ~55 agents in this repo still execute on import (live
// writes, process.exit); this one does not, and this file would hang, mutate
// the queue or exit the runner if that ever regressed.
test('importing the agent does not run it', () => {
  const src = readFileSync(join(ROOT, 'agents/queue-autoapply/index.js'), 'utf8');
  assert.match(src, /const isDirectRun = process\.argv\[1\] && fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/);
  assert.match(src, /if \(isDirectRun\) \{/);
  // No top-level `run(...)` outside the guard.
  const guardAt = src.indexOf('if (isDirectRun) {');
  assert.doesNotMatch(src.slice(0, guardAt).replace(/^export async function run\(.*$/m, ''), /^run\(/m);
});

test('the agent never sends an immediate notification', () => {
  // CLAUDE.md's digest convention: routine agent output waits for the 5 AM
  // consolidated email. `immediate: true` is for outages.
  const src = readFileSync(join(ROOT, 'agents/queue-autoapply/index.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /immediate:\s*true/);
  assert.equal((code.match(/await notify\(/g) || []).length, 1, 'exactly one notification per run');
});

// ── product counting for the collection-gap dismissal gate ───────────────────

const PRODUCTS = [
  { id: 1, title: 'Coconut Oil Toothpaste — Mint', handle: 'coconut-oil-toothpaste', tags: 'toothpaste' },
  { id: 2, title: 'Coconut Oil Toothpaste — Cinnamon', handle: 'coconut-oil-toothpaste-cinnamon', tags: 'toothpaste' },
  { id: 3, title: 'Coconut Oil Deodorant', handle: 'coconut-oil-deodorant', tags: 'deodorant' },
];

test('product counts are resolved for pending collection-gaps only', async () => {
  let calls = 0;
  const deps = { getProducts: async () => { calls++; return PRODUCTS; } };
  const counts = await buildProductCounts([
    { slug: 'glycerin-free-toothpaste', trigger: 'collection-gap', status: 'pending', signal_source: { keyword: 'glycerin free toothpaste' } },
    { slug: 'already-live', trigger: 'collection-gap', status: 'published', signal_source: { keyword: 'coconut oil' } },
    { slug: 'a-post', trigger: 'quick-win', status: 'pending' },
  ], deps);

  assert.equal(calls, 1, 'ONE product read for the whole run, not one per item');
  assert.equal(counts.get('glycerin-free-toothpaste'), 0);
  assert.equal(counts.has('already-live'), false, 'a published item is not re-evaluated');
  assert.equal(counts.has('a-post'), false);
});

test('no collection-gap items means no Shopify call at all', async () => {
  let calls = 0;
  const counts = await buildProductCounts(
    [{ slug: 'x', trigger: 'quick-win', status: 'pending' }],
    { getProducts: async () => { calls++; return PRODUCTS; } },
  );
  assert.equal(calls, 0);
  assert.equal(counts.size, 0);
});

test('a collection-gap that really does hold two products counts two', async () => {
  const counts = await buildProductCounts(
    [{ slug: 'coconut-oil-toothpaste', trigger: 'collection-gap', status: 'pending', signal_source: { keyword: 'coconut oil toothpaste' } }],
    { getProducts: async () => PRODUCTS },
  );
  assert.equal(counts.get('coconut-oil-toothpaste'), 2);
});

// ── the wiring the policy depends on ─────────────────────────────────────────

test('the agent reads cluster revenue from the report, not from a hardcoded list', () => {
  const src = readFileSync(join(ROOT, 'agents/queue-autoapply/index.js'), 'utf8');
  // The path and the classification used to be built inline here. They moved to
  // lib/cluster-hold.js when the $0-cluster HOLD was added to the refresh
  // agents, so the queue and the refreshers hold on one reading of one report
  // rather than on two copies that could drift apart.
  assert.match(src, /loadClusterHold/);
  assert.match(src, /cluster-hold\.js/);
  assert.doesNotMatch(src, /['"]toothpaste['"]/, 'no cluster may be named in the agent');
  const loader = readFileSync(join(ROOT, 'lib/cluster-hold.js'), 'utf8');
  assert.match(loader, /seo-impact['"],\s*['"]latest\.json/, 'the shared loader owns the path now');
  const policy = readFileSync(join(ROOT, 'lib/queue-autoapply.js'), 'utf8');
  assert.doesNotMatch(policy, /['"]toothpaste['"]/, 'no cluster may be named in the policy either');
});

test('the agent is wired into the daily scheduler after its producers', () => {
  const sched = readFileSync(join(ROOT, 'scheduler.js'), 'utf8');
  assert.match(sched, /agents\/queue-autoapply\/index\.js/);
  // Must run AFTER the producers that write queue items and alongside the
  // publish-approved steps, not before them.
  const autoapplyAt = sched.indexOf('agents/queue-autoapply/index.js');
  assert.ok(autoapplyAt > sched.indexOf('agents/calendar-runner/index.js --run'), 'after the content pipeline');
  assert.ok(autoapplyAt > sched.indexOf('product-optimizer/index.js --publish-approved'), 'after the approved-item publishers');
});
