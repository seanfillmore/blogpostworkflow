// tests/lib/ad-brief-plan.test.js
//
// The selection brain, extracted from agents/ad-brief/index.js on 2026-08-17 so the
// dashboard's /api/ad-brief routes can answer "is this product briefable" and "what would a
// Generate click cost" with the SAME code the agent acts on, instead of importing the agent
// (Anthropic + @google/genai + sharp) into the single 961 MB dashboard process.
//
// The functions the agent re-exports unchanged (formatsForAngle, angleRelevance,
// assertClusterCoverage, AWARENESS_TO_FORMAT_AWARENESS) keep their existing coverage in
// tests/agents/ad-brief.test.js, which imports them through the agent. This file pins the two
// things that are NEW: the coverage verdict as data, and the plan.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLUSTER_HANDLES, clusterCoverage, assertClusterCoverage, planBriefs, formatsForAngle,
} from '../../lib/ad-brief-plan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PERSONAS = JSON.parse(readFileSync(join(ROOT, 'data', 'context', 'personas.json'), 'utf8'));

test('clusterCoverage says yes for a skin-cluster handle and carries no reason', () => {
  const v = clusterCoverage('coconut-lotion', PERSONAS);
  assert.equal(v.covered, true);
  assert.equal(v.reason, null);
  assert.equal(v.cluster, 'skin');
});

test('clusterCoverage says no for a product outside the cluster, and the reason names the remedy', () => {
  const v = clusterCoverage('coconut-oil-deodorant', PERSONAS);
  assert.equal(v.covered, false);
  assert.match(v.reason, /coconut-oil-deodorant/);
  assert.match(v.reason, /voice-of-customer/, 'the operator must be told what unlocks it');
  assert.deepEqual(v.handles, CLUSTER_HANDLES.skin, 'and which handles the cluster does cover');
});

test('a personas file with an unknown or missing cluster covers nothing', () => {
  for (const data of [{ cluster: 'griddle' }, {}, null]) {
    const v = clusterCoverage('coconut-lotion', data);
    assert.equal(v.covered, false);
    assert.ok(v.reason, 'must always explain itself');
  }
});

// THE PARITY THAT MATTERS. The dashboard labels a product unavailable from clusterCoverage;
// the agent aborts from assertClusterCoverage. If those two ever disagreed, the tab would
// offer a product that then fails, or hide one that would have worked — which is the exact
// defect this extraction fixes. assertClusterCoverage is a thin throw around clusterCoverage,
// and this is what holds it to that.
test('assertClusterCoverage throws exactly when clusterCoverage says not covered', () => {
  const handles = ['coconut-lotion', 'coconut-soap', 'coconut-oil-deodorant', 'coconut-oil-toothpaste', 'foam-soap-bundle'];
  for (const h of handles) {
    const covered = clusterCoverage(h, PERSONAS).covered;
    if (covered) {
      assert.doesNotThrow(() => assertClusterCoverage(h, PERSONAS), `${h} is covered, must not throw`);
    } else {
      assert.throws(() => assertClusterCoverage(h, PERSONAS), /not covered by/, `${h} is uncovered, must throw`);
    }
  }
});

// ── planBriefs ─────────────────────────────────────────────────────────────────────────

test('planBriefs counts one copy call per angle THAT HAS A FORMAT, never per angle', () => {
  const plan = planBriefs({ personasData: PERSONAS, product: { handle: 'coconut-lotion', title: 'Coconut Lotion' } });
  assert.equal(plan.covered, true);
  assert.ok(plan.angleCount > 0);
  assert.equal(plan.angles.length, plan.angleCount);

  // An angle whose awareness level no format covers (unaware / most-aware) is recorded as a
  // brief with no render target and costs nothing — same rule generateBriefs applies. The
  // count must therefore be strictly the angles with a format, which for this product's
  // personas is fewer than the total.
  const withFormat = plan.angles.filter(a => a.format).length;
  assert.equal(plan.copyCalls, withFormat);
  assert.ok(plan.copyCalls < plan.angleCount, 'this product has unaware/most-aware angles that cost nothing');
});

test('every planned angle names itself, its persona, its awareness and its resolved format', () => {
  const plan = planBriefs({ personasData: PERSONAS, product: { handle: 'coconut-soap', title: 'Coconut Soap' } });
  for (const a of plan.angles) {
    assert.ok(a.angleId, 'angleId');
    assert.ok(a.personaId, 'personaId');
    assert.ok(a.awareness, 'awareness');
    // Cross-check against the format resolver rather than restating the mapping here.
    assert.equal(a.format, formatsForAngle({ awareness: a.awareness }).proposed);
  }
});

test('planBriefs on an uncovered product plans nothing and says why — it never guesses a cluster', () => {
  const plan = planBriefs({ personasData: PERSONAS, product: { handle: 'coconut-oil-deodorant', title: 'Deodorant' } });
  assert.equal(plan.covered, false);
  assert.equal(plan.angleCount, 0);
  assert.equal(plan.copyCalls, 0);
  assert.deepEqual(plan.angles, []);
  assert.match(plan.reason, /voice-of-customer/);
});

test('planBriefs honours an explicit angle list, and refuses an unknown id rather than silently dropping it', () => {
  const first = planBriefs({ personasData: PERSONAS, product: { handle: 'coconut-lotion' } }).angles[0];
  const one = planBriefs({
    personasData: PERSONAS, product: { handle: 'coconut-lotion' }, angleIds: [first.angleId],
  });
  assert.equal(one.angleCount, 1);
  assert.equal(one.angles[0].angleId, first.angleId);

  const bad = planBriefs({
    personasData: PERSONAS, product: { handle: 'coconut-lotion' }, angleIds: ['p99a99'],
  });
  assert.equal(bad.angleCount, 0);
  assert.match(bad.reason, /unknown angle id/);
});

test('planBriefs relevance filtering keeps a lotion angle off bar soap', () => {
  // The reason angleRelevance exists: without it a lotion-specific angle would be briefed
  // against soap at one Opus call apiece. Asserted as a difference between two real products
  // rather than against a hand-written angle, so it stays true as personas.json is rewritten.
  const lotion = planBriefs({ personasData: PERSONAS, product: { handle: 'coconut-lotion', title: 'Coconut Lotion' } });
  const soap = planBriefs({ personasData: PERSONAS, product: { handle: 'coconut-soap', title: 'Coconut Bar Soap' } });
  assert.ok(lotion.angleCount > soap.angleCount,
    'lotion-specific angles must not also be planned for bar soap');
});
