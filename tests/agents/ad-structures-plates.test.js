import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildScenePrompt, parseStrayText, checkStrayText, buildStrayTextPrompt } from '../../agents/ad-concepts/plates.js';
import { runConceptTakes } from '../../agents/ad-concepts/shots.js';
import { loadLibrary } from '../../agents/ad-concepts/structures.js';
import { createRenderBudget } from '../../agents/ad-studio/index.js';

const product = { handle: 'coconut-soap', title: 'Coconut Soap', productNoun: 'bar soap', productDescriptionShort: 'a round wrapped bar', physicalDescription: 'A long physical description.', unitCount: 1, labelInk: 'black', labelStrings: ['real SKIN CARE'], badgeStrings: [] };
const lib = loadLibrary();
const split = lib.structures.find(s => s.id === 'they-think-we-sell');

test('scene prompt: phone look, filled placeholders, no-text, unit, ink, fidelity', () => {
  const p = buildScenePrompt({ structure: split, which: 'primary', product, brandKit: { palette_hexes: ['#fff'] } });
  assert.doesNotMatch(p, /Brand palette/);
  assert.match(p, /smartphone photo/);
  assert.match(p, /Our bar soap \(a round wrapped bar\)/);
  assert.doesNotMatch(p, /\{product/);
  assert.match(p, /no text anywhere in the image except our product's own printed label/);
  assert.match(p, /EXACTLY 1 UNIT OF OUR PRODUCT/);
  assert.match(p, /black ink/);
  assert.match(p, /PRODUCT FIDELITY IS THE HIGHEST PRIORITY/);
  assert.match(p, /No human hands or faces\./);
  const fb = buildScenePrompt({ structure: split, which: 'fallback', product, brandKit: {} });
  assert.match(fb, /very large on a plain light surface/);
});

test('label ink defaults to black; no short description leaves no empty parens or full description', () => {
  const p = buildScenePrompt({ structure: split, which: 'primary', product: { ...product, labelInk: null, productDescriptionShort: undefined }, brandKit: {} });
  assert.match(p, /label is black ink\./);
  assert.doesNotMatch(p, /\(\s*\)/);
  assert.doesNotMatch(p.split('\n\n')[1], /physical description/);
  assert.match(p, /Our bar soap stands upright/);
});

test('product-free plate fallback scene', () => {
  const p = buildScenePrompt({ structure: split, which: 'fallback', product, brandKit: {}, plate: split.plates[0] });
  assert.match(p, /jar of solid white cooking fat/);
  assert.doesNotMatch(p, /FIDELITY|EXACTLY 1 UNIT/);
});

test('product-free plate has no fidelity block', () => {
  const plate = split.plates[0];
  const p = buildScenePrompt({ structure: split, which: 'primary', product, brandKit: {}, plate });
  assert.match(p, /smartphone photo/);
  assert.match(p, /no logo, no printing, no text anywhere/i);
  assert.doesNotMatch(p, /FIDELITY|EXACTLY 1 UNIT|label is/);
});

test('stray-text parser fails closed', () => {
  assert.equal(parseStrayText('{"hasText":false,"hasLogo":false,"detail":""}').ok, true);
  assert.equal(parseStrayText('{"hasText":true,"hasLogo":false,"detail":"tub says COCO"}').ok, false);
  assert.equal(parseStrayText('{"hasText":false,"hasLogo":true}').ok, false);
  assert.equal(parseStrayText('nope').ok, false);
  assert.equal(parseStrayText('{"hasText":false}').ok, false);
  assert.match(buildStrayTextPrompt(), /hasText/);
});

test('checkStrayText throws on max_tokens, parses otherwise', async () => {
  const mk = (m) => ({ messages: { create: async () => m } });
  const args = { model: 'm', buffer: Buffer.from([1]), mediaType: 'image/jpeg' };
  await assert.rejects(checkStrayText({ ...args, anthropic: mk({ stop_reason: 'max_tokens', content: [] }) }), /token limit/);
  const r = await checkStrayText({ ...args, anthropic: mk({ content: [{ type: 'text', text: '{"hasText":false,"hasLogo":false}' }] }) });
  assert.equal(r.ok, true);
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1]);
test('fallback prompt used after 2 primary fails; no repair round', async () => {
  const prompts = [];
  const results = [false, false, true, false];
  const r = await runConceptTakes({
    concept: { people: 'none' }, prompt: 'PRIMARY', fallbackPrompt: 'FALLBACK',
    render: async (p) => { prompts.push(p); return JPEG; },
    verify: async () => ({ mediaType: 'image/jpeg', proof: { ok: results.shift(), reasons: ['x'] } }),
    budget: createRenderBudget(30),
  });
  assert.deepEqual(prompts, ['PRIMARY', 'PRIMARY', 'FALLBACK', 'FALLBACK']);
  assert.equal(r.repaired, false);
  assert.equal(r.usedFallback, true);
  assert.equal(r.passed.length, 1);
});

test('fallback not used when a primary take passes', async () => {
  const prompts = [];
  const r = await runConceptTakes({
    concept: { people: 'none' }, prompt: 'PRIMARY', fallbackPrompt: 'FALLBACK',
    render: async (p) => { prompts.push(p); return JPEG; },
    verify: async () => ({ mediaType: 'image/jpeg', proof: { ok: true } }),
    budget: createRenderBudget(30),
  });
  assert.deepEqual(prompts, ['PRIMARY', 'PRIMARY']);
  assert.equal(r.usedFallback, false);
  assert.equal(r.passed.length, 2);
});
