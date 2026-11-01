import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, planRun, cooldownTargets, targetSlugFor, isKnownSchema, collectionGapText,
  MAX_APPLIES_PER_RUN, MAX_GATE_ATTEMPTS,
} from '../../lib/queue-autoapply.js';
import { classifyClusters } from '../../lib/cluster-revenue.js';
import { WIDE_ORDERS } from '../helpers/cluster-fixtures.js';

// Real `clusters[]` shape from data/reports/seo-impact/latest.json. The verdict
// is made on `productRevenue` — what each category SOLD over the 90-day judging
// window — so the toothpaste $0 below is SYNTHETIC: the real figure is $71.50
// and the real report has no dud in it at all.
const SOLD = { lotion: 1757.1, soap: 324.85, deodorant: 165, 'lip balm': 117, toothpaste: 0 };
const CLUSTERS = classifyClusters([
  { cluster: 'body lotion', revenue: 313.49, clicks: 35, pages: 20 },
  { cluster: 'hand soap', revenue: 62.4, clicks: 4, pages: 4 },
  { cluster: 'lip balm', revenue: 48, clicks: 4, pages: 6 },
  { cluster: 'deodorant', revenue: 38.25, clicks: 121, pages: 21 },
  { cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 },
  { cluster: 'soap', revenue: 0, clicks: 223, pages: 24 },
], { productRevenue: SOLD, windowOrders: WIDE_ORDERS });

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
  const earning = classifyClusters([{ cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 }],
    { productRevenue: { ...SOLD, toothpaste: 12.5 }, windowOrders: WIDE_ORDERS });
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

// ── which skips will NEVER clear on their own ───────────────────────────────
//
// `decide()` returns action 'skip' for several reasons and they are not alike.
// Some clear themselves — a 30-day cooldown expires, an over-cap item is picked
// up on the next run, an unresolvable product count resolves when Shopify comes
// back. Others are PERMANENT: no automated run will ever change the verdict, the
// item stays `pending` forever, and it was indistinguishable in the report from
// an item that simply had to wait.
//
// The worst case is an item that TRANSITIONS: while gate_attempts < 3 it sits in
// `gated[]`, which the digest describes as "stays pending for the repair loop".
// At 3 it silently moves into `skipped[]` with no field change — from "the loop
// owns this" to "nobody owns this", invisibly.
//
// Sean asked for exactly these to surface as a decision he makes. Measured on
// production 2026-09-18, that is ONE item of four pending, which is what makes
// it appropriate for the digest at all.
const gapItem = (over = {}) => ({
  slug: 'g', trigger: 'collection-gap', status: 'pending',
  created_at: '2026-07-20T00:00:00Z', ...over,
});

test('an exhausted editor gate needs a human decision', () => {
  const d = decide(pending({ autoapply: { gate_attempts: 3 } }), { clusters: CLUSTERS });
  assert.equal(d.action, 'skip');
  assert.equal(d.decision, 'editor-gate-exhausted');
  assert.match(d.reason, /needs a human/);
});

test('a trigger outside the auto-apply policy needs a human decision', () => {
  const d = decide(pending({ trigger: 'faq-expansion' }), { clusters: CLUSTERS });
  assert.equal(d.action, 'skip');
  assert.equal(d.decision, 'not-auto-appliable');
});

test('a collection-gap that passes both gates needs a human decision', () => {
  const d = decide(gapItem(), {
    clusters: CLUSTERS,
    productCounts: new Map([['g', 4]]),
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.decision, 'create-page');
});

test('a health-claim refusal needs a human decision — it cannot regenerate here', () => {
  const d = decide(
    pending({ proposed_meta: { seo_title: 'Cures Eczema Fast' } }),
    { clusters: CLUSTERS },
  );
  assert.equal(d.action, 'skip');
  assert.equal(d.gate, 'health-claim');
  assert.equal(d.decision, 'health-claim');
});

// ── the self-clearing skips must NOT be marked ──────────────────────────────
//
// Marking these would rebuild the to-do list the digest just stopped printing.

test('a cooldown skip is NOT a decision — it clears itself in 30 days', () => {
  const d = decide(pending(), { clusters: CLUSTERS, cooldown: new Set(['s']) });
  assert.equal(d.action, 'skip');
  assert.equal(d.decision, undefined);
});

test('an over-cap skip is NOT a decision — the next run picks it up', () => {
  const items = Array.from({ length: 8 }, (_, i) => pending({ slug: `s${i}` }));
  const { skip } = planRun(items, { clusters: CLUSTERS });
  const capped = skip.filter((s) => /over the per-run cap/.test(s.reason));
  assert.ok(capped.length > 0, 'the fixture must actually exceed the cap');
  for (const s of capped) assert.equal(s.decision, undefined);
});

test('an unresolvable product count is NOT a decision — Shopify may come back', () => {
  const d = decide(gapItem(), { clusters: CLUSTERS, productCounts: new Map() });
  assert.equal(d.action, 'skip');
  assert.equal(d.decision, undefined);
});

test('another producer\'s schema is NOT a decision — pdp-builder owns it', () => {
  const d = decide({ type: 'pdp-product', slug: 'x', status: 'pending' }, { clusters: CLUSTERS });
  assert.equal(d.action, 'skip');
  assert.equal(d.decision, undefined, 'a pdp-builder artifact is not a queue decision');
});

test('a dismissal is a verdict, not a decision awaiting one', () => {
  const d = decide(gapItem(), { clusters: CLUSTERS, productCounts: new Map([['g', 1]]) });
  assert.equal(d.action, 'dismiss');
  assert.equal(d.decision, undefined);
});

test('planRun collects the decisions it found', () => {
  const items = [
    pending({ slug: 'stuck', autoapply: { gate_attempts: 3 } }),
    pending({ slug: 'fine' }),
    pending({ slug: 'waiting' }),
  ];
  const { decisions } = planRun(items, { clusters: CLUSTERS, cooldown: new Set(['waiting']) });
  assert.equal(decisions.length, 1, 'only the permanently-stuck item');
  assert.equal(decisions[0].item.slug, 'stuck');
  assert.equal(decisions[0].decision, 'editor-gate-exhausted');
});
