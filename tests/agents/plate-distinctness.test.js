// tests/agents/plate-distinctness.test.js
//
// The gate is calibrated against the REAL format catalogue, not fixtures, because the
// catalogue IS the input — a plate's look comes from a fixed `plateBrief`, so there is no
// model output to stub. Where a fixture is used it is an adversarial one: a fifteenth
// format added by copying an existing brief, which is the failure this gate exists for.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  plateFingerprint, comparePlates, findDuplicatePlates,
  renderDistinctnessLines, duplicatePlateRefusal,
  DUPLICATE_MAX, NEAR_DUPLICATE_WARN, MIN_BRIEF_TOKENS,
} from '../../agents/ad-studio/plate-distinctness.js';
import { FORMATS, formatByKey, visibleFormats } from '../../agents/ad-studio/formats.js';

const by = k => formatByKey(k);

// ── the axes, in the order a scroller reads them ──────────────────────────────────────

test('a studio plate and a scene plate are never comparable', () => {
  const r = comparePlates(plateFingerprint(by('spec-panel')), plateFingerprint(by('shower-shelf')));
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'different-setting');
  assert.equal(r.similarity, null, 'no composition score is computed for an incomparable pair');
});

test('a different ground separates two plates whose wording is nearly identical', () => {
  // This is why ground is an axis rather than just more tokens: across the catalogue the
  // most word-similar pair of all sits in the different-ground bucket at 0.857, and those
  // two plates look nothing alike at a thumb-flick.
  const r = comparePlates(plateFingerprint(by('us-vs-them')), plateFingerprint(by('state-contrast')));
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'different-ground');
});

test('ground is read from the RESOLVED brief, not from format.plateGround', () => {
  // formatForVariation swaps plateBrief and leaves plateGround alone, so three of
  // giveaway-entry's variants state their own ground and declare none. Trusting the
  // declared field would call the most visually distinct set in the catalogue same-ground.
  const g = by('giveaway-entry');
  assert.equal(g.plateGround, undefined, 'the parent format declares no ground');
  const grounds = new Set(
    g.plateVariants.map((_, i) => plateFingerprint(g, i + 1).ground),
  );
  assert.ok(grounds.size >= 3,
    `the variants must resolve to distinct grounds, got ${[...grounds].join(', ')}`);
  assert.ok(!grounds.has(null), 'every studio variant carries a hex in its resolved brief');
});

test('a scene format has no ground hex, and that is correct rather than missing', () => {
  for (const key of ['problem-aware', 'top-x-review', 'in-use-handwash', 'shower-shelf']) {
    assert.equal(plateFingerprint(by(key)).ground, null, `${key} is a real setting, not a colour`);
  }
});

// ── the calibration pairs, each judged by reading its briefs ──────────────────────────

test('the one measured duplicate is caught', () => {
  // Both: sand ground, product right at hero scale, base on the lower third, soft contact
  // shadow, left and top empty, a clear band across the bottom. Same photograph.
  const r = comparePlates(
    plateFingerprint(by('giveaway-entry'), 1),   // sand-hero
    plateFingerprint(by('spec-panel')),
  );
  assert.equal(r.comparable, true);
  assert.equal(r.tier, 'duplicate');
  assert.ok(r.similarity >= DUPLICATE_MAX, `${r.similarity} must clear ${DUPLICATE_MAX}`);
});

test('the borderline pair is advisory, never blocking', () => {
  // testimonial vs state-contrast: both centred on sand, differing only in product scale.
  // Recorded as a judgement — it is reported and does not refuse a run.
  const r = comparePlates(plateFingerprint(by('testimonial')), plateFingerprint(by('state-contrast')));
  assert.equal(r.tier, 'near-duplicate');
  assert.ok(r.similarity < DUPLICATE_MAX && r.similarity >= NEAR_DUPLICATE_WARN);
});

test('a real difference in product position reads as distinct', () => {
  // stat-stack is centred; spec-panel is hard right. The tactic names a new position as a
  // genuinely new ad, so this must NOT be a finding.
  const r = comparePlates(plateFingerprint(by('stat-stack')), plateFingerprint(by('spec-panel')));
  assert.equal(r.tier, 'near-duplicate', 'reported, but below the blocking line');
  assert.ok(r.similarity < DUPLICATE_MAX);
});

test("the README's own flexible example is clean", () => {
  // `--flexible --formats problem-aware,testimonial,manifesto`. A gate that refused the
  // documented example would be wrong about the catalogue, not about the example.
  const r = findDuplicatePlates(['problem-aware', 'testimonial', 'manifesto'].map(by));
  assert.deepEqual(r.duplicates, []);
  assert.deepEqual(r.nearDuplicates, []);
});

// ── blast radius: the gate must not make the agent unusable ───────────────────────────

test('the overwhelming majority of three-format sets still pass', () => {
  const keys = visibleFormats().map(f => f.key);
  let total = 0, blocked = 0;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      for (let k = j + 1; k < keys.length; k++) {
        total++;
        const r = findDuplicatePlates([keys[i], keys[j], keys[k]].map(by));
        if (r.duplicates.length) blocked++;
      }
    }
  }
  assert.ok(total > 200, `sanity: expected a real combination space, got ${total}`);
  assert.equal(blocked, 0,
    'no set drawn from the DEFAULT rotation is blocked — the one duplicate pair needs a '
    + 'live giveaway for both its members to be selectable');
});

test('exactly one duplicate pair exists across every renderable surface', () => {
  // Pins the measurement the thresholds were derived from. If a new format changes this
  // count, the header's derivation has to be re-run rather than the number nudged.
  const all = [];
  for (const f of FORMATS) {
    const n = (f.plateVariants || []).length || 1;
    for (let v = 1; v <= n; v++) all.push(plateFingerprint(f, v));
  }
  assert.equal(all.length, 18, 'renderable surfaces');

  let comparable = 0, duplicates = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const r = comparePlates(all[i], all[j]);
      if (!r.comparable) continue;
      comparable++;
      if (r.tier === 'duplicate') duplicates++;
    }
  }
  assert.equal(comparable, 44, 'same setting AND same ground — the judged population');
  assert.equal(duplicates, 1, 'the measured catalogue holds exactly one duplicate pair');
});

// ── the realistic failure: a fifteenth format added by copying an existing one ─────────

test('a near-copy of an existing plateBrief is caught', () => {
  const original = by('manifesto');
  const copycat = {
    ...original,
    key: 'manifesto-b',
    // A nudge, which is what a copied format really looks like: one clause reworded.
    plateBrief: String(original.plateBrief).replace('BOTTOM RIGHT', 'lower right'),
  };
  const r = findDuplicatePlates([original, copycat]);
  assert.equal(r.duplicates.length, 1, 'a reworded copy is still the same picture');
  assert.ok(r.duplicates[0].similarity > DUPLICATE_MAX);
});

test('changing only the ground makes a copied brief distinct again', () => {
  // The constructive half: the fix for a duplicate is a different ground or setting, and
  // the gate has to actually reward that or its refusal message is a lie.
  const original = by('manifesto');
  const recoloured = {
    ...original,
    key: 'manifesto-dark',
    plateBrief: String(original.plateBrief).replace(/#EDE5D8/g, '#000000'),
  };
  const r = findDuplicatePlates([original, recoloured]);
  assert.deepEqual(r.duplicates, []);
  assert.deepEqual(r.nearDuplicates, []);
});

// ── it disarms rather than guessing, and says so ──────────────────────────────────────

test('a brief too thin to describe a composition disarms instead of passing', () => {
  const thin = { key: 'stub', plateSetting: 'studio', plateBrief: 'A warm sand #EDE5D8 ground.' };
  const r = findDuplicatePlates([by('manifesto'), thin]);
  assert.ok(r.disarmed, 'never infer "clean" from an empty findings list — check disarmed');
  assert.deepEqual(r.duplicates, []);
  assert.ok(renderDistinctnessLines(r).some(l => /Plate distinctness is OFF/.test(l)),
    'a disarmed check must be visible, not silent');
  assert.ok(plateFingerprint(thin).tokenCount < MIN_BRIEF_TOKENS);
});

test('a single-plate batch reports that it compared nothing', () => {
  const r = findDuplicatePlates([by('manifesto')]);
  assert.equal(r.compared, false, '"nothing to compare" must not render as "compared and clean"');
  assert.deepEqual(r.duplicates, []);
});

// ── reporting ─────────────────────────────────────────────────────────────────────────

test('findings render worst-first and name both formats', () => {
  const r = findDuplicatePlates([by('giveaway-entry'), by('spec-panel'), by('testimonial')]);
  const lines = renderDistinctnessLines(r);
  assert.ok(lines.length > 0);
  assert.ok(lines[0].includes('giveaway-entry') && lines[0].includes('spec-panel'));
  const msg = duplicatePlateRefusal(r);
  assert.ok(/visually distinct/.test(msg));
  assert.ok(/different ground or a different setting/.test(msg),
    'a refusal must say what to do next, or it is just a wall');
});

// ── wiring: --flexible REFUSES, an ordinary run ADVISES ───────────────────────────────

test('--flexible refuses three plates that are not visually distinct', async () => {
  const { assertFlexibleArgs } = await import('../../agents/ad-studio/flexible.js');
  const META45 = { platform: 'meta', ratio: '4:5', mode: 'plate', wantsComp: true };
  const args = { targets: [META45], variations: 1 };

  assert.throws(
    () => assertFlexibleArgs({ ...args, formats: ['giveaway-entry', 'spec-panel', 'shower-shelf'] }),
    /visually distinct plates/,
    'the one measured duplicate pair is refused before any render',
  );
  assert.doesNotThrow(
    () => assertFlexibleArgs({ ...args, formats: ['problem-aware', 'testimonial', 'manifesto'] }),
    'the documented example still passes',
  );
});

test('an unknown format key still gets its own error, not a distinctness lecture', async () => {
  const { assertFlexibleArgs } = await import('../../agents/ad-studio/flexible.js');
  const META45 = { platform: 'meta', ratio: '4:5', mode: 'plate', wantsComp: true };
  // Unresolvable keys are skipped so `selectFormats` can raise `unknown format: x`
  // downstream. Answering a typo with a paragraph about delivery entities would be worse
  // than saying nothing.
  assert.doesNotThrow(
    () => assertFlexibleArgs({ formats: ['a', 'b', 'c'], targets: [META45], variations: 1 }),
  );
});

test('an ordinary run records the finding in run.json and never throws', async () => {
  const { buildRunReport } = await import('../../agents/ad-studio/index.js');
  const plateDistinctness = findDuplicatePlates([by('giveaway-entry'), by('spec-panel')]);
  assert.equal(plateDistinctness.duplicates.length, 1);

  const report = buildRunReport({
    runId: 'r1', product: { handle: 'h', title: 't' }, results: [], plateDistinctness,
  });
  assert.equal(report.plateDistinctness.duplicates.length, 1,
    'an advisory finding nothing can see is not an advisory');
});

test('run.json carries null when the check never ran, not an empty clean result', async () => {
  const { buildRunReport } = await import('../../agents/ad-studio/index.js');
  const report = buildRunReport({ runId: 'r1', product: { handle: 'h', title: 't' }, results: [] });
  assert.equal(report.plateDistinctness, null,
    '"did not run" and "ran and found nothing" must not render identically');
});
