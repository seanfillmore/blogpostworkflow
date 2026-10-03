import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { sceneTextBlock, typeBandBlock, buildTakePrompt, parseShotSpec, runConceptTakes } from '../../agents/ad-concepts/shots.js';
import { createRenderBudget } from '../../agents/ad-studio/index.js';

const product = { handle: 'coconut-soap', unitCount: 1, labelStrings: ['real SKIN CARE', '3.4 oz • 84g'], badgeStrings: [], physicalDescription: 'A round wrapped bar.' };
const concept = { id: 'c', people: 'none', sceneText: 'illegible-print', typeBand: 'top' };

test('scene-text and type-band blocks are exact', () => {
  assert.match(sceneTextBlock('illegible-print'), /fine grey hairlines only/);
  assert.match(sceneTextBlock('illegible-print'), /no letters, numbers or symbols/);
  assert.match(sceneTextBlock('none'), /no text anywhere except our product's own label/i);
  assert.match(typeBandBlock('top'), /top quarter/);
  assert.match(typeBandBlock('bottom'), /bottom quarter/);
});

test('take prompt = scene + type band + scene text + product fidelity; people flag reaches fidelity', () => {
  const p = buildTakePrompt({ sceneSpec: 'A kitchen.', concept, product, brandKit: {} });
  assert.ok(p.startsWith('A kitchen.'));
  assert.match(p, /PRODUCT FIDELITY IS THE HIGHEST PRIORITY/);
  assert.match(p, /No human hands or faces\./);
  assert.match(p, /EXACTLY 1 UNIT OF OUR PRODUCT/);
  const withPeople = buildTakePrompt({ sceneSpec: 'A man.', concept: { ...concept, people: 'face' }, product, brandKit: {} });
  assert.doesNotMatch(withPeople, /No human hands or faces/);
  assert.throws(() => parseShotSpec('   '), /empty/);
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1]);
const mkVerify = (results) => async () => ({ mediaType: 'image/jpeg', proof: { ok: results.shift(), reasons: ['volume wrong'] } });

test('three takes; passes are kept; people flag stamped', async () => {
  const r = await runConceptTakes({
    concept: { ...concept, people: 'hands' }, prompt: 'P', render: async () => JPEG,
    verify: mkVerify([false, true, true]), budget: createRenderBudget(30),
  });
  assert.equal(r.takes.length, 3);
  assert.deepEqual(r.passed.map(t => t.n), [2, 3]);
  assert.deepEqual(r.passed[0].needsHumanReview, ['anatomy']);
  assert.equal(r.repaired, false);
});

test('zero passes triggers ONE repair round of two takes with the reasons in the prompt', async () => {
  const prompts = [];
  const r = await runConceptTakes({
    concept, prompt: 'P', render: async (p) => { prompts.push(p); return JPEG; },
    verify: mkVerify([false, false, false, true, false]), budget: createRenderBudget(30),
  });
  assert.equal(r.takes.length, 5);
  assert.equal(r.repaired, true);
  assert.match(prompts[3], /PREVIOUS TAKES FAILED[\s\S]*volume wrong/);
  assert.deepEqual(r.passed.map(t => t.n), [4]);
});

test('budget exhaustion stops takes and says so', async () => {
  const r = await runConceptTakes({ concept, prompt: 'P', render: async () => JPEG, verify: mkVerify([false, false]), budget: createRenderBudget(2) });
  assert.equal(r.takes.length, 2);
  assert.equal(r.budgetStopped, true);
});

test('onTake fires per verified take, before a later render can throw', async () => {
  const seen = [];
  let n = 0;
  await assert.rejects(runConceptTakes({
    concept, prompt: 'P', render: async () => { if (++n === 3) throw new Error('boom'); return JPEG; },
    verify: mkVerify([true, true, true]), budget: createRenderBudget(30), onTake: (t) => seen.push(t.n),
  }), /boom/);
  assert.deepEqual(seen, [1, 2]);
});
