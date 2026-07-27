// tests/agents/pdp-builder/prompt-builder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';
import {
  buildClusterSystemPrompt,
  buildProductSystemPrompt,
} from '../../../agents/pdp-builder/lib/prompt-builder.js';

const foundation = loadFoundation();

test('buildClusterSystemPrompt: includes voice doc text', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /Clinical-confident/);
});

test('buildClusterSystemPrompt: includes the cluster POV', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /## toothpaste/);
});

test('buildClusterSystemPrompt: includes ingredient stories for the cluster (in the Hero ingredient stories block)', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  // Extract the section between "# Hero ingredient stories" and the next "# " heading
  const m = prompt.match(/# Hero ingredient stories[^\n]*\n([\s\S]*?)\n# /);
  assert.ok(m, 'prompt has a "# Hero ingredient stories" section');
  const heroBlock = m[1];
  // The block should be JSON; parse it and verify both ingredients are present
  const parsed = JSON.parse(heroBlock.trim());
  const keys = Object.keys(parsed);
  assert.ok(
    keys.includes('organic_virgin_coconut_oil'),
    `expected organic_virgin_coconut_oil in hero block, got keys: ${keys.join(', ')}`
  );
  assert.ok(
    keys.includes('wildcrafted_myrrh'),
    `expected wildcrafted_myrrh in hero block, got keys: ${keys.join(', ')}`
  );
});

test('buildClusterSystemPrompt: includes comparison framework', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /SLS|Aluminum|Fluoride/);
});

test('buildClusterSystemPrompt: includes founder narrative', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /Real Skin Care/);
});

test('buildClusterSystemPrompt: throws on unknown cluster', () => {
  assert.throws(
    () => buildClusterSystemPrompt({ foundation, clusterName: 'unknown' }),
    /unknown/,
  );
});

test('buildProductSystemPrompt: includes product handle and known ingredients', () => {
  const prompt = buildProductSystemPrompt({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
  });
  assert.match(prompt, /coconut-oil-toothpaste/);
  assert.match(prompt, /baking soda/i);
});

test('buildProductSystemPrompt: includes voice doc + cluster POV (same as cluster prompt baseline)', () => {
  const prompt = buildProductSystemPrompt({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
  });
  assert.match(prompt, /Clinical-confident/);
  assert.match(prompt, /## toothpaste/);
});

// ── voice-of-customer (optional foundation input) ──────────────────────────
// load-foundation populates foundation.voiceOfCustomer; before this it was
// loaded and then dropped on the floor because prompt-builder never read it.
const VOC_MD = '## Objections\n\n- **Greasy** — 9 mentions. > "It takes forever to absorb."';

test('buildClusterSystemPrompt: includes the voice-of-customer research when present', () => {
  const prompt = buildClusterSystemPrompt({
    foundation: { ...foundation, voiceOfCustomer: VOC_MD },
    clusterName: 'toothpaste',
  });
  assert.match(prompt, /# Voice of customer/);
  assert.match(prompt, /It takes forever to absorb\./);
  assert.match(prompt, /INTERNAL RESEARCH/);
  assert.match(prompt, /Never quote it verbatim/);
  // The research is skin-cluster only, but every one of the 7 clusters in
  // config/ingredients.json gets this prompt — the model has to be told so.
  assert.match(prompt, /Scope: this research covers the skin cluster ONLY/);
  assert.match(prompt, /coconut bar soap and foaming hand soap/);
  assert.match(prompt, /disregard this section entirely/);
});

test('buildProductSystemPrompt: includes the voice-of-customer research when present', () => {
  const prompt = buildProductSystemPrompt({
    foundation: { ...foundation, voiceOfCustomer: VOC_MD },
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
  });
  assert.match(prompt, /# Voice of customer/);
  assert.match(prompt, /It takes forever to absorb\./);
  assert.match(prompt, /Scope: this research covers the skin cluster ONLY/);
});

// Degradation contract: with the artifact absent the prompt must be byte-identical
// to the one produced before the voice-of-customer branch existed.
test('buildClusterSystemPrompt: contributes nothing at all when voiceOfCustomer is empty', () => {
  const args = { clusterName: 'toothpaste' };
  const withEmpty = buildClusterSystemPrompt({ foundation: { ...foundation, voiceOfCustomer: '' }, ...args });
  const withBlank = buildClusterSystemPrompt({ foundation: { ...foundation, voiceOfCustomer: '   \n\n' }, ...args });
  const withMissing = (() => {
    const { voiceOfCustomer, ...rest } = foundation;
    return buildClusterSystemPrompt({ foundation: rest, ...args });
  })();
  assert.equal(withEmpty, withMissing);
  assert.equal(withBlank, withMissing);
  assert.ok(!withEmpty.includes('# Voice of customer'));
});

test('buildProductSystemPrompt: contributes nothing at all when voiceOfCustomer is empty', () => {
  const args = {
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
  };
  const withEmpty = buildProductSystemPrompt({ foundation: { ...foundation, voiceOfCustomer: '' }, ...args });
  const { voiceOfCustomer, ...rest } = foundation;
  const withMissing = buildProductSystemPrompt({ foundation: rest, ...args });
  assert.equal(withEmpty, withMissing);
  assert.ok(!withEmpty.includes('# Voice of customer'));
});
