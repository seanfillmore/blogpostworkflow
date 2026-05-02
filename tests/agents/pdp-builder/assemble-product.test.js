// tests/agents/pdp-builder/assemble-product.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';
import { assembleProduct } from '../../../agents/pdp-builder/lib/assemble-product.js';

const foundation = loadFoundation();

function fakeClaudeResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const VALID_PRODUCT_OUTPUT = {
  seoTitle: 'Coconut Oil Toothpaste | Fluoride-Free | Real Skin Care',  // 55 chars
  metaDescription: 'A'.repeat(150),
  bodyHtml: '<p>' + Array(150).fill('word').join(' ') + '</p>',
  metafieldOverrides: {},
};

test('assembleProduct: returns pending queue item when valid', async () => {
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(VALID_PRODUCT_OUTPUT) },
  };
  const result = await assembleProduct({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
    claudeClient: mockClient,
  });
  assert.equal(result.type, 'pdp-product');
  assert.equal(result.slug, 'coconut-oil-toothpaste');
  assert.equal(result.status, 'pending');
  assert.equal(result.proposed.seoTitle.length, 55);
});

test('assembleProduct: returns needs_rework when seoTitle too long', async () => {
  const longTitleOutput = { ...VALID_PRODUCT_OUTPUT, seoTitle: 'X'.repeat(80) };
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(longTitleOutput) },
  };
  const result = await assembleProduct({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
    claudeClient: mockClient,
  });
  assert.equal(result.status, 'needs_rework');
  assert.match(JSON.stringify(result.validation.errors), /seoTitle.*80/);
});

test('assembleProduct: rejects competitor name in body_html', async () => {
  const competitorOutput = {
    ...VALID_PRODUCT_OUTPUT,
    bodyHtml: '<p>Better than Tom\'s of Maine.</p> ' + Array(140).fill('word').join(' '),
  };
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(competitorOutput) },
  };
  const result = await assembleProduct({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
    claudeClient: mockClient,
  });
  assert.equal(result.status, 'needs_rework');
});

test('assembleProduct: rejects fabricated ingredient (hydroxyapatite) in body_html', async () => {
  const fabricatedOutput = {
    seoTitle: 'Coconut Oil Toothpaste | Fluoride-Free | Real Skin Care',
    metaDescription: 'A'.repeat(150),
    bodyHtml: '<p>Contains hydroxyapatite to remineralize enamel naturally. ' + Array(140).fill('word').join(' ') + '</p>',
    metafieldOverrides: {},
  };
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(fabricatedOutput) },
  };
  const result = await assembleProduct({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
    claudeClient: mockClient,
  });
  assert.equal(result.status, 'needs_rework');
  assert.match(JSON.stringify(result.validation.errors), /hydroxyapatite/i);
});
