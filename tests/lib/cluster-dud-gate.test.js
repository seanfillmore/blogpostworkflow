// tests/lib/cluster-dud-gate.test.js
//
// `proven_dud` is a HARD BLOCK in four consumers and one of them DELETES paid-for
// research off disk (`scripts/triage-orphan-briefs.mjs --drop-non-earning
// --apply` → `lib/brief-triage.js` → `unlinkSync`). A deletion path must be at
// least as evidence-hungry as `lib/cluster-hold.js`'s spend hold, which only
// pauses LLM cycles. Before 2026-08-23 it was strictly LESS: the hold required
// two agreeing sources, the deletions required one directional one.
//
// These tests pin the wiring, not just the library. A correct
// `corroboratedClassification` that nobody calls fixes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClusterHold, corroboratedClassification } from '../../lib/cluster-hold.js';
import { classifyClusters } from '../../lib/cluster-revenue.js';
import { triageOrphanBrief } from '../../lib/brief-triage.js';
import { decide } from '../../lib/queue-autoapply.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOTALS = { organic_conversions: 8, organic_sessions: 1067 };

// Real measured product revenue by family, from data/snapshots/shopify on the
// production server. soap really sells; toothpaste really does not.
const MEASURED = [
  { label: 'report window (28d)', available: true, orders: 18, revenue: 1079.46, aov: 59.97, truncatedDays: 0, byFamily: { lotion: 909, 'lip balm': 120, soap: 156, deodorant: 60 } },
  { label: 'wide window (90d)', available: true, orders: 39, revenue: 2118.77, aov: 54.33, truncatedDays: 0, byFamily: { lotion: 1695.3, soap: 365.7, deodorant: 180, 'lip balm': 120, toothpaste: 39 } },
];

// A report in which attribution is broken: soap reads $0 on enough traffic to
// clear the evidence bar, while the orders say it is a top-two category. This is
// the 2026-08-22 incident with the click count raised past the new bar, so the
// scenario survives the taxonomy fix that removed its original cause.
const BROKEN = buildClusterHold(classifyClusters([
  { cluster: 'soap', revenue: 0, clicks: 500, pages: 24 },
  { cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 },
], { totals: TOTALS }), { measured: MEASURED, generatedAt: 'X' });

test('an uncorroborated dud is downgraded to unproven, with the reason kept', () => {
  const c = corroboratedClassification(BROKEN);
  assert.equal(BROKEN.classified.soap.status, 'proven_dud', 'seo-impact alone still says dud');
  assert.equal(c.soap.status, 'unproven', 'the orders overrule it');
  assert.equal(c.soap.uncorroboratedDud, true);
  assert.match(c.soap.evidence, /ATTRIBUTION DISAGREEMENT/);
});

test('a corroborated dud stays a dud — the gate is not just switched off', () => {
  const c = corroboratedClassification(BROKEN);
  assert.equal(c.toothpaste.status, 'proven_dud');
  assert.match(c.toothpaste.corroboration, /below one average order in every window/);
});

test('with no order snapshots at all, nothing is a dud', () => {
  const blind = buildClusterHold(classifyClusters([
    { cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 },
  ], { totals: TOTALS }), { measured: [] });
  const c = corroboratedClassification(blind);
  assert.equal(c.toothpaste.status, 'unproven');
});

test('corroboratedClassification tolerates a missing hold', () => {
  assert.deepEqual(corroboratedClassification(null), {});
  assert.deepEqual(corroboratedClassification({}), {});
});

// ── the four consumers ───────────────────────────────────────────────────────

test('brief-triage does NOT delete a brief in a cluster the orders show is earning', () => {
  const CTX = { publishedKeywords: [], rejectedKeywords: [], brandTerms: [] };
  const raw = triageOrphanBrief('oatmeal soap', { ...CTX, clusterRevenue: BROKEN.classified });
  assert.equal(raw.keep, false, 'the raw classification would have deleted it');

  const gated = triageOrphanBrief('oatmeal soap', { ...CTX, clusterRevenue: corroboratedClassification(BROKEN) });
  assert.equal(gated.keep, true, 'the corroborated one keeps it');

  // And the corroborated gate still deletes what is genuinely dead.
  const dud = triageOrphanBrief('toothpaste for canker sores', { ...CTX, clusterRevenue: corroboratedClassification(BROKEN) });
  assert.equal(dud.keep, false);
});

test('queue-autoapply does NOT dismiss a collection-gap in a mis-attributed cluster', () => {
  const gap = (slug, keyword) => ({
    slug, trigger: 'collection-gap', status: 'pending', created_at: '2026-07-20T00:00:00Z',
    signal_source: { keyword },
  });
  const counts = new Map([['bar-soap', 4], ['glycerin-free-toothpaste', 4]]);

  const raw = decide(gap('bar-soap', 'natural bar soap'), { clusters: BROKEN.classified, productCounts: counts });
  assert.equal(raw.action, 'dismiss', 'the raw classification would have dismissed it');

  const clusters = corroboratedClassification(BROKEN);
  assert.notEqual(decide(gap('bar-soap', 'natural bar soap'), { clusters, productCounts: counts }).action, 'dismiss');
  assert.equal(decide(gap('glycerin-free-toothpaste', 'glycerin free toothpaste'), { clusters, productCounts: counts }).action, 'dismiss');
});

test('every consumer that BLOCKS or DELETES reads the corroborated view', () => {
  // A source-level pin. `classifyClusters` on its own answers one directional
  // question; anything irreversible must go through loadClusterHold first.
  const consumers = [
    'agents/content-strategist/index.js',   // drops LLM proposals, clears calendar items
    'agents/calendar-runner/index.js',      // blocks items from ever being drafted
    'agents/queue-autoapply/index.js',      // dismisses collection-gaps
    'scripts/triage-orphan-briefs.mjs',     // unlinkSync's brief files
  ];
  for (const rel of consumers) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /corroboratedClassification/, `${rel} must read the corroborated classification`);
    assert.ok(
      !/\bclassifyClusters\s*\(/.test(src),
      `${rel} must not classify the report itself — that bypasses the order corroboration`,
    );
  }
});

test('the deletion script refuses to run without the report at all', () => {
  const src = readFileSync(join(ROOT, 'scripts/triage-orphan-briefs.mjs'), 'utf8');
  assert.match(src, /hold\.available/, 'a missing report must stop --drop-non-earning, not soften it');
  assert.match(src, /process\.exit\(1\)/);
});
