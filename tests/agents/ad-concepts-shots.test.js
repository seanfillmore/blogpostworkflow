import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { unitBlock, runConceptTakes } from '../../agents/ad-concepts/shots.js';
import { createRenderBudget } from '../../agents/ad-studio/index.js';

const concept = { id: 'c', people: 'none' };

test('unitBlock states the exact unit count', () => {
  assert.match(unitBlock(1), /EXACTLY 1 UNIT OF OUR PRODUCT\./);
  assert.match(unitBlock(3), /EXACTLY 3 UNITS OF OUR PRODUCT\./);
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

