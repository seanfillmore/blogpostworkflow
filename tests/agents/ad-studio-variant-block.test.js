import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildCopyPrompt, buildVariantBlock } from '../../agents/ad-studio/copy.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';

const args = { format: formatByKey('problem-aware'), product: { title: 'Coconut Bar Soap', handle: 'coconut-soap', priceLabel: '$12' }, pdpBody: 'available in lavender, citrus and pure unscented' };

test('buildCopyPrompt carries buildVariantBlock(variant) verbatim (ad-concepts reuses the same block)', () => {
  for (const variant of ['nourishing-tea-tree', 'pure-unscented']) {
    const block = buildVariantBlock(variant);
    assert.match(block, new RegExp(`^\\nVARIANT: ${variant} `));
    assert.ok(buildCopyPrompt({ ...args, variant }).includes(block), variant);
  }
  assert.match(buildVariantBlock('pure-unscented'), /NO added fragrance/);
  assert.doesNotMatch(buildVariantBlock('nourishing-tea-tree'), /NO added fragrance/);
  assert.equal(buildVariantBlock(null), '');
  assert.equal(buildVariantBlock(undefined), '');
});
