// tests/agents/ad-studio-render-fidelity-block.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildRenderPrompt, buildProductFidelityBlock } from '../../agents/ad-studio/render.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';

const product = {
  handle: 'coconut-soap', unitCount: 1, variant: 'nourishing-tea-tree',
  labelStrings: ['real SKIN CARE', 'nourishing tea tree', '3.4 oz • 84g'],
  badgeStrings: ['Made with Organic Coconut Oil'],
  physicalDescription: 'A round, puck-shaped bar of soap wrapped in white pleated paper.',
};

test('the block buildRenderPrompt embeds is the exported block, verbatim', () => {
  const prompt = buildRenderPrompt({ format: formatByKey('problem-aware'), zones: {}, product, brandKit: { palette_hexes: [] }, mode: 'plate' });
  assert.ok(prompt.includes(buildProductFidelityBlock(product)));
});

test('default forbids people; allowPeople permits them but protects the label', () => {
  assert.match(buildProductFidelityBlock(product), /No human hands or faces\.$/);
  const allowed = buildProductFidelityBlock(product, { allowPeople: true });
  assert.doesNotMatch(allowed, /No human hands or faces/);
  assert.match(allowed, /never touching, covering or obscuring the product's label/);
  assert.match(allowed, /3\.4 oz • 84g/);
});
