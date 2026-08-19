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
import { overlayPersonas } from '../../lib/operator-angles.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLUSTER_HANDLES, clusterCoverage, assertClusterCoverage, planBriefs, formatsForAngle,
  angleRelevance, allPersonaAngles, withheldAngleIds, withheldNote,
} from '../../lib/ad-brief-plan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// OVERLAID, because that is what every consumer reads. agents/ad-brief and the dashboard
// route both apply lib/operator-angles.js at load, so the raw file is not what any of them
// plans against. It still carries retired p2a2, whose proof says "goes into the bloodstream"
// and whose quotes say "toxic chemicals" — language the systemic-absorption and toxicity
// categories (added 2026-08-18) correctly reject. Asserting the RAW file here would demand
// that research never contain a claim, which is not research's job; sanitizePersonas filtering
// it at read time IS the design.
const PERSONAS = overlayPersonas(
  JSON.parse(readFileSync(join(ROOT, 'data', 'context', 'personas.json'), 'utf8')),
  { root: ROOT },
);

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

  // THE RULE, which is what this test is really for: a copy call is spent on an angle if and
  // only if a format can render it. An angle with no format is recorded as a brief with no
  // render target and costs nothing.
  const withFormat = plan.angles.filter(a => a.format).length;
  assert.equal(plan.copyCalls, withFormat);

  // Until 2026-08-18 this also asserted copyCalls < angleCount, because `unaware` and
  // `most-aware` had no format and so were free. fact-hook and spec-panel closed that, so
  // every angle is now renderable and every angle now COSTS — which is a real spend change,
  // not a neutral one: this product went from 8 paid copy calls per full run to 11. The
  // rule above is unchanged; what changed is that nothing is exempt from it any more.
  assert.equal(plan.copyCalls, plan.angleCount, 'every awareness level has a format, so every angle costs a call');
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

// ── the live p5a2 bug, on the REAL personas.json (code review, 2026-08-17) ─────────────
//
// "The winter survival cream" (p5a2) used to be briefed against coconut-soap because its
// `proof` field mentions "hand soap users" in passing. Checked against the actual file on
// disk, with the actual production catalog title (no "cream" anywhere in it), rather than
// a hand-written fixture — this is the exact request that shipped copy for the wrong
// product and cost one real Opus call.
test('the real p5a2 angle ("The winter survival cream") is not briefed against coconut-soap', () => {
  const p5a2 = PERSONAS.personas.flatMap(p => p.angles).find(a => a.id === 'p5a2');
  assert.equal(p5a2.label, 'The winter survival cream', 'sanity: this is still the angle the live bug named');
  assert.equal(angleRelevance(p5a2, { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap | 3.4oz' }), false);
});

// ── the three sanity checks the fix was verified against, pinned as tests ──────────────
test('p5a3 ("The bar you put out for guests") is soap-relevant and not lotion-relevant', () => {
  const p5a3 = PERSONAS.personas.flatMap(p => p.angles).find(a => a.id === 'p5a3');
  assert.equal(angleRelevance(p5a3, { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap | 3.4oz' }), true);
  assert.equal(
    angleRelevance(p5a3, { handle: 'coconut-lotion', title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients' }),
    false
  );
});

test('p3a2 ("The first lotion that didn\'t react") is lotion-relevant and not soap-relevant', () => {
  const p3a2 = PERSONAS.personas.flatMap(p => p.angles).find(a => a.id === 'p3a2');
  assert.equal(
    angleRelevance(p3a2, { handle: 'coconut-lotion', title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients' }),
    true
  );
  assert.equal(angleRelevance(p3a2, { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap | 3.4oz' }), false);
});

// Was labelled "After prescriptions failed" until 2026-08-17, when the label, objection and
// proof were re-worded to drop the drug and disease names a cosmetic may not use. The
// relevance behaviour is unchanged and is the point of this test: the label still names no
// product, and the re-worded objection still only reaches "lotion"/"balms" inside the
// customer's own rhetorical aside, with nothing in `proof` to corroborate it.
test('p1a1 ("After everything else failed") names no product and stays relevant to both', () => {
  const p1a1 = PERSONAS.personas.flatMap(p => p.angles).find(a => a.id === 'p1a1');
  assert.equal(p1a1.label, 'After everything else failed', 'sanity: the repaired label');
  assert.equal(
    angleRelevance(p1a1, { handle: 'coconut-lotion', title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients' }),
    true
  );
  assert.equal(angleRelevance(p1a1, { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap | 3.4oz' }), true);
});

// ── health-claim withholding, before a click can spend on it ──────────────────
//
// allPersonaAngles is the ONE flattening both this module's planBriefs() and the agent's
// main() select from. An angle whose copy-facing prose names a disease or a drug is not
// briefable: ad-studio's health-claims gate will hard-fail the copy it produces, AFTER the
// Opus call is paid for. So it is withheld here, which keeps the Briefs tab's angle list,
// the dry-run count and the agent's real spend agreeing about which angles exist.

const DIRTY = {
  cluster: 'skin',
  personas: [
    {
      id: 'p1', name: 'The tried-everything buyer', summary: 'Nothing worked.',
      angles: [
        { id: 'p1a1', label: 'After prescriptions failed', awareness: 'problem-aware',
          objection_addressed: 'Why would this be different?', proof: 'Reviewers say it lasts',
          hook_examples: [], source_quotes: ['q'] },
        { id: 'p1a2', label: 'Tried everything', awareness: 'problem-aware',
          objection_addressed: 'Why would this be different?', proof: 'Reviewers say it lasts',
          hook_examples: [], source_quotes: ['q'] },
      ],
    },
  ],
};

test('allPersonaAngles withholds an angle whose copy-facing prose carries a health claim', () => {
  assert.deepEqual(allPersonaAngles(DIRTY).map(pa => pa.angle.id), ['p1a2']);
  assert.deepEqual(withheldAngleIds(DIRTY), ['p1a1']);
});

test('planBriefs never offers — or charges for — a withheld angle', () => {
  const plan = planBriefs({ personasData: DIRTY, product: { handle: 'coconut-lotion', title: 'Coconut Lotion' } });
  assert.deepEqual(plan.angles.map(a => a.angleId), ['p1a2']);
  assert.equal(plan.angleCount, 1);
  assert.equal(plan.copyCalls, 1, 'the withheld angle must not appear in the cost the button shows');
});

test('naming a withheld angle by hand says "withheld", not "unknown"', () => {
  // Without this the only feedback for --angles p1a1 is a message asserting the id does not
  // exist, which sends the reader hunting a typo that is not there.
  const plan = planBriefs({ personasData: DIRTY, product: { handle: 'coconut-lotion' }, angleIds: ['p1a1'] });
  assert.equal(plan.angleCount, 0);
  assert.match(plan.reason, /p1a1/);
  assert.match(plan.reason, /health claim/);
  assert.match(plan.reason, /health-claims\.js/, 'and points at the gate that decided');
});

test('withheldNote stays silent for an id that is genuinely unknown', () => {
  assert.equal(withheldNote(['p99a99'], DIRTY), '');
  assert.match(planBriefs({ personasData: DIRTY, product: { handle: 'coconut-lotion' }, angleIds: ['p99a99'] }).reason,
    /^unknown angle id\(s\): p99a99$/);
});

test('a persona whose every angle is withheld disappears without breaking the plan', () => {
  const allDirty = { cluster: 'skin', personas: [{ ...DIRTY.personas[0], angles: [DIRTY.personas[0].angles[0]] }] };
  const plan = planBriefs({ personasData: allDirty, product: { handle: 'coconut-lotion' } });
  assert.equal(plan.covered, true, 'the product is still covered — there is simply nothing to brief');
  assert.equal(plan.angleCount, 0);
  assert.equal(plan.copyCalls, 0);
});

// The real file, which is what the Briefs tab actually plans against.
test('no angle in the committed personas.json is withheld', () => {
  assert.deepEqual(withheldAngleIds(PERSONAS), [],
    'a withheld angle is an angle the ad pipeline can never brief — repair personas.json instead');
});

// planBriefs must give the SAME format answer the agent will act on. The dashboard panel
// tells the operator what a Generate click is about to do, and a panel that promises
// `offer-focused` while the agent spends the call on `giveaway-entry` is the drift this
// whole module exists to prevent — arriving through the one input the plan does not read
// from disk. The caller supplies the giveaway verdict; both callers get it from
// lib/giveaway-claim-source.js.
test('planBriefs reflects a live giveaway in the format it promises', () => {
  const product = { handle: 'coconut-soap', title: 'Coconut Soap' };
  const off = planBriefs({ personasData: PERSONAS, product });
  const on = planBriefs({ personasData: PERSONAS, product, giveawayLive: true });

  assert.equal(on.copyCalls, off.copyCalls, 'a giveaway changes WHICH format, never how many calls');
  assert.equal(on.angleCount, off.angleCount);

  const productAware = on.angles.filter(a => a.awareness === 'product-aware');
  assert.ok(productAware.length, 'this product has a product-aware angle to check');
  for (const a of productAware) assert.equal(a.format, 'giveaway-entry');
  for (const a of off.angles.filter(x => x.awareness === 'product-aware')) assert.equal(a.format, 'offer-focused');

  // Nothing else moves.
  const unchanged = (plan) => plan.angles.filter(a => a.awareness !== 'product-aware').map(a => [a.angleId, a.format]);
  assert.deepEqual(unchanged(on), unchanged(off));
});
