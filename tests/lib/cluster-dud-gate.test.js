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
import { corroboratedClassification } from '../../lib/cluster-hold.js';
import { classifyClusters } from '../../lib/cluster-revenue.js';
import { triageOrphanBrief } from '../../lib/brief-triage.js';
import { decide } from '../../lib/queue-autoapply.js';
import { holdFor, SOLD_90D, PAGES_EARNED_90D, WIDE_ORDERS } from '../helpers/cluster-fixtures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A report in which SOURCE A is broken: something zeroes the product-title join
// and `soap` reads $0 over the judging window, while its PAGES plainly earned
// $110.49 over the same window. That is the 2026-08-19 incident on the new
// basis — and, unlike the old fixture, it works at soap's REAL 227 clicks
// instead of a count raised to clear a 400-click bar.
//
// `toothpaste` is zeroed on BOTH sources here, which is SYNTHETIC: it really
// sold $71.50 over the judging window. The fixture needs one genuinely-dead
// cluster to prove the gate is not simply switched off.
const BROKEN = holdFor({
  clusters: [
    { cluster: 'soap', revenue: 0, clicks: 227, pages: 28 },
    { cluster: 'toothpaste', revenue: 0, clicks: 640, pages: 24 },
  ],
  sold: { ...SOLD_90D, soap: 0, toothpaste: 0 },
  earned: { ...PAGES_EARNED_90D, toothpaste: 0 },
  generatedAt: 'X',
});

test('an uncorroborated dud is downgraded to unproven, with the reason kept', () => {
  const c = corroboratedClassification(BROKEN);
  assert.equal(BROKEN.classified.soap.status, 'proven_dud', 'source A alone still says dud');
  assert.equal(c.soap.status, 'unproven', 'the cross-check overrules it');
  assert.equal(c.soap.uncorroboratedDud, true);
  assert.match(c.soap.evidence, /SOURCES DISAGREE/);
  assert.match(c.soap.evidence, /110\.49/, 'and keeps the number that blocked the hold');
});

test('a corroborated dud stays a dud — the gate is not just switched off', () => {
  const c = corroboratedClassification(BROKEN);
  assert.equal(c.toothpaste.status, 'proven_dud');
  assert.match(c.toothpaste.corroboration, /both sources agree/);
});

test('with no cross-check at all, nothing is a dud', () => {
  const blind = holdFor({
    clusters: [{ cluster: 'toothpaste', revenue: 0, clicks: 640, pages: 24 }],
    sold: { ...SOLD_90D, toothpaste: 0 },
    earned: null,
  });
  const c = corroboratedClassification(blind);
  assert.equal(c.toothpaste.status, 'unproven');
});

test('and with no product reading at all — the pre-migration report — nothing is a dud', () => {
  // The deploy path: latest.json on the server was written before
  // `clusters_product_wide` existed, so it carries neither source.
  const old = classifyClusters(
    [{ cluster: 'toothpaste', revenue: 0, clicks: 640, pages: 24 }], { windowOrders: WIDE_ORDERS },
  );
  assert.equal(old.toothpaste.status, 'unproven');
  assert.match(old.toothpaste.evidence, /no product-revenue reading/i);
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
