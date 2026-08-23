import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, planRun, cooldownTargets, targetSlugFor, isKnownSchema, collectionGapText,
  MAX_APPLIES_PER_RUN, MAX_GATE_ATTEMPTS,
} from '../../lib/queue-autoapply.js';
import { classifyClusters } from '../../lib/cluster-revenue.js';

// Real shape, from data/reports/seo-impact/latest.json on the production server
// (2026-08-22). toothpaste is the $0 cluster CLAUDE.md names; body lotion earns.
const CLUSTERS = classifyClusters([
  { cluster: 'body lotion', revenue: 313.49, clicks: 35, pages: 20 },
  { cluster: 'hand soap', revenue: 62.4, clicks: 4, pages: 4 },
  { cluster: 'lip balm', revenue: 48, clicks: 4, pages: 6 },
  { cluster: 'deodorant', revenue: 38.25, clicks: 121, pages: 21 },
  { cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 },
  { cluster: 'soap', revenue: 0, clicks: 223, pages: 24 },
]);

const pending = (over = {}) => ({ slug: 's', trigger: 'quick-win', status: 'pending', created_at: '2026-07-20T00:00:00Z', ...over });

// ── schema tolerance ─────────────────────────────────────────────────────────

test('an item from another producer is left strictly alone', () => {
  // agents/pdp-builder writes into data/performance-queue/ with `type:` instead
  // of `trigger:` and a non-standard status. It is not ours to action.
  const pdp = { slug: 'coconut-lotion', type: 'pdp-cluster', status: 'needs_rework' };
  assert.equal(isKnownSchema(pdp), false);
  assert.equal(decide(pdp, { clusters: CLUSTERS }).action, 'skip');
  assert.match(decide(pdp, { clusters: CLUSTERS }).reason, /another producer/);
});

test('decide tolerates junk without throwing', () => {
  for (const junk of [null, undefined, {}, { slug: 'x' }, { trigger: 'quick-win' }]) {
    assert.equal(decide(junk, { clusters: CLUSTERS }).action, 'skip');
  }
});

test('only pending items are actioned', () => {
  for (const status of ['approved', 'published', 'dismissed', 'in_progress', 'failed', 'completed']) {
    assert.equal(decide(pending({ status }), { clusters: CLUSTERS }).action, 'skip', status);
  }
});

// ── auto-apply ───────────────────────────────────────────────────────────────

test('every trigger in the chosen policy auto-applies', () => {
  for (const trigger of ['seo-opportunity', 'quick-win', 'flop-refresh', 'page-meta-rewrite', 'low-ctr-meta', 'legacy-flop']) {
    assert.equal(decide(pending({ trigger }), { clusters: CLUSTERS }).action, 'apply', trigger);
  }
});

test('triggers outside the policy are left for a human', () => {
  // These create or rewrite commercial pages through their own agents' publish
  // paths; the chosen policy does not cover them.
  for (const trigger of ['collection-content', 'product-description-rewrite', 'product-meta-rewrite', 'product-title-rewrite', 'faq-expansion']) {
    const d = decide(pending({ trigger }), { clusters: CLUSTERS });
    assert.equal(d.action, 'skip', trigger);
    assert.match(d.reason, /not in the auto-apply policy/);
  }
});

test('an item whose target another item already actioned inside the cooldown is skipped', () => {
  const cooldown = new Set(['coconut-oil-lotion']);
  const d = decide(pending({ slug: 'seo-opp-coconut-oil-lotion', trigger: 'seo-opportunity' }), { clusters: CLUSTERS, cooldown });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /30-day cooldown/);
});

test('an item the editor has repeatedly blocked stops being retried', () => {
  const d = decide(pending({ autoapply: { gate_attempts: MAX_GATE_ATTEMPTS } }), { clusters: CLUSTERS });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /needs a human/);
  assert.equal(decide(pending({ autoapply: { gate_attempts: MAX_GATE_ATTEMPTS - 1 } }), { clusters: CLUSTERS }).action, 'apply');
});

// ── collection-gap: the two revenue gates ────────────────────────────────────

const gap = (over = {}) => ({
  slug: 'glycerin-free-toothpaste',
  trigger: 'collection-gap',
  status: 'pending',
  signal_source: { keyword: 'glycerin free toothpaste' },
  proposed_collection: { handle: 'glycerin-free-toothpaste', title: 'Glycerin Free Toothpaste' },
  created_at: '2026-07-19T00:00:00Z',
  ...over,
});

test('a collection-gap holding fewer than 2 distinct products is auto-dismissed', () => {
  for (const n of [0, 1]) {
    const d = decide(gap(), { clusters: CLUSTERS, productCounts: new Map([['glycerin-free-toothpaste', n]]) });
    assert.equal(d.action, 'dismiss', `${n} products`);
    assert.match(d.reason, /2\+ products/);
  }
});

test('both live toothpaste collection-gaps are auto-dismissed as a $0 cluster', () => {
  // The two items actually pending on the server, 2026-08-22. Toothpaste is
  // 663 clicks across 24 pages for $0 — the cluster CLAUDE.md flags by name.
  const counts = new Map([['glycerin-free-toothpaste', 4], ['sodium-lauryl-sulfate-free-toothpaste', 4]]);
  for (const slug of ['glycerin-free-toothpaste', 'sodium-lauryl-sulfate-free-toothpaste']) {
    const d = decide(gap({ slug, signal_source: { keyword: slug.replace(/-/g, ' ') } }), { clusters: CLUSTERS, productCounts: counts });
    assert.equal(d.action, 'dismiss', slug);
    assert.match(d.reason, /toothpaste.*\$0|\$0.*toothpaste/);
  }
});

test('the $0-cluster list is read from the report, never hardcoded', () => {
  // Same item, a report in which toothpaste has started earning → no dismissal
  // on revenue grounds. Nothing in the policy names a cluster.
  const earning = classifyClusters([{ cluster: 'toothpaste', revenue: 12.5, clicks: 663, pages: 24 }]);
  const d = decide(gap(), { clusters: earning, productCounts: new Map([['glycerin-free-toothpaste', 4]]) });
  assert.notEqual(d.action, 'dismiss');
});

test('the product-count rule holds even when revenue data is missing entirely', () => {
  const d = decide(gap(), { clusters: {}, productCounts: new Map([['glycerin-free-toothpaste', 1]]) });
  assert.equal(d.action, 'dismiss');
});

test('a collection-gap that passes both gates is still never auto-created', () => {
  const d = decide(gap({ slug: 'coconut-body-lotion', signal_source: { keyword: 'coconut body lotion' } }),
    { clusters: CLUSTERS, productCounts: new Map([['coconut-body-lotion', 3]]) });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /human decision/);
});

test('an unresolvable product count is a skip, never a silent apply or dismiss', () => {
  const d = decide(gap(), { clusters: CLUSTERS, productCounts: new Map() });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /could not resolve/);
});

test('collectionGapText prefers the GSC keyword over the handle', () => {
  assert.equal(collectionGapText(gap()), 'glycerin free toothpaste');
  assert.equal(collectionGapText({ slug: 'x', proposed_collection: { handle: 'h' } }), 'h');
  assert.equal(collectionGapText(null), '');
});

// ── target slugs + cooldown ──────────────────────────────────────────────────

test('a seo-opportunity item resolves to the post it actually edits', () => {
  assert.equal(targetSlugFor({ slug: 'seo-opp-coconut-oil-lotion' }), 'coconut-oil-lotion');
  assert.equal(targetSlugFor({ slug: 'coconut-oil-lotion' }), 'coconut-oil-lotion');
  assert.equal(targetSlugFor(null), '');
});

test('cooldownTargets mirrors activeSlugs: published and completed are hot for 30 days', () => {
  const now = Date.parse('2026-08-22T00:00:00Z');
  const cd = cooldownTargets([
    { slug: 'fresh', status: 'published', published_at: '2026-08-20T00:00:00Z' },
    { slug: 'stale', status: 'published', published_at: '2026-06-01T00:00:00Z' },
    { slug: 'seo-opp-done', status: 'completed', completed_at: '2026-08-19T00:00:00Z' },
    { slug: 'undated', status: 'published' },
    { slug: 'pend', status: 'pending' },
    { slug: 'gone', status: 'dismissed' },
    { slug: 'broke', status: 'failed' },
    null,
  ], { now });
  assert.ok(cd.has('fresh'));
  assert.ok(!cd.has('stale'), '30 days elapsed → no longer hot');
  assert.ok(cd.has('done'), 'a completed seo-opp blocks the POST slug, not its own filename');
  assert.ok(cd.has('undated'), 'actioned with no date → assume hot rather than guess');
  for (const s of ['pend', 'gone', 'broke']) assert.ok(!cd.has(s), s);
});

// ── the per-run cap ──────────────────────────────────────────────────────────

test('the run is capped and drains oldest-first', () => {
  const items = [];
  for (let i = 0; i < 9; i++) items.push(pending({ slug: `s${i}`, created_at: `2026-07-${String(i + 10).padStart(2, '0')}T00:00:00Z` }));
  const plan = planRun(items.slice().reverse(), { clusters: CLUSTERS });
  assert.equal(plan.apply.length, MAX_APPLIES_PER_RUN);
  assert.deepEqual(plan.apply.map((d) => d.item.slug), ['s0', 's1', 's2', 's3', 's4']);
  const overflow = plan.skip.filter((d) => /over the per-run cap/.test(d.reason));
  assert.equal(overflow.length, 4);
});

test('dismissals are not capped — they touch no live page', () => {
  const counts = new Map();
  const items = [];
  for (let i = 0; i < 9; i++) {
    items.push(gap({ slug: `dud-toothpaste-${i}`, signal_source: { keyword: `dud toothpaste ${i}` } }));
    counts.set(`dud-toothpaste-${i}`, 0);
  }
  const plan = planRun(items, { clusters: CLUSTERS, productCounts: counts });
  assert.equal(plan.dismiss.length, 9);
  assert.equal(plan.apply.length, 0);
});

test('planRun is total: every item lands in exactly one bucket', () => {
  const items = [pending(), gap(), { slug: 'p', type: 'pdp-cluster', status: 'needs_rework' }, null];
  const plan = planRun(items, { clusters: CLUSTERS, productCounts: new Map([['glycerin-free-toothpaste', 0]]) });
  assert.equal(plan.apply.length + plan.dismiss.length + plan.skip.length, items.length);
});

test('planRun on an empty or missing queue is a no-op', () => {
  for (const q of [[], null, undefined]) {
    const plan = planRun(q, { clusters: CLUSTERS });
    assert.deepEqual([plan.apply.length, plan.dismiss.length, plan.skip.length], [0, 0, 0]);
  }
});
