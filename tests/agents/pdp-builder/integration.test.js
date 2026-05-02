// tests/agents/pdp-builder/integration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';
import { assembleCluster } from '../../../agents/pdp-builder/lib/assemble-cluster.js';
import { assembleProduct } from '../../../agents/pdp-builder/lib/assemble-product.js';

const foundation = loadFoundation();

function fakeClaudeResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

test('integration: cluster mode end-to-end (toothpaste, mocked Claude)', async () => {
  const validClusterOutput = {
    hookLine: 'For sensitive teeth, less in the formula means more for your enamel.',
    ingredientCards: [
      { name: 'Organic Virgin Coconut Oil', role: 'antimicrobial', story: Array(50).fill('word').join(' ') },
      { name: 'Baking Soda', role: 'pH balance', story: Array(50).fill('word').join(' ') },
      { name: 'Wildcrafted Myrrh Powder', role: 'anti-inflammatory', story: Array(50).fill('word').join(' ') },
    ],
    mechanismBlock: Array(90).fill('word').join(' '),
    founderBlock: Array(70).fill('word').join(' '),
    freeFrom: ['No SLS', 'No fluoride', 'No glycerin coating', 'No synthetic sweeteners'],
    faq: Array.from({ length: 7 }, (_, i) => ({ question: `Q${i+1}`, answer: Array(50).fill('w').join(' ') })),
    badges: ['Vegan', 'Cruelty-Free', 'Made in USA', 'Small Batch'],
    guarantees: ['30-day MBG', 'Free shipping over $50', 'Clean ingredients', 'Handcrafted'],
  };
  const mockClient = { messages: { create: async () => fakeClaudeResponse(validClusterOutput) } };

  const item = await assembleCluster({
    foundation,
    clusterName: 'toothpaste',
    claudeClient: mockClient,
  });

  assert.equal(item.type, 'pdp-cluster');
  assert.equal(item.status, 'pending');
  assert.ok(item.foundation_version);
  assert.equal(item.proposed.faq.length, 7);
  assert.ok(item.proposed.hookLine.length > 0);
});

test('integration: product mode end-to-end (coconut-oil-toothpaste, mocked Claude)', async () => {
  const validProductOutput = {
    seoTitle: 'Coconut Oil Toothpaste | Fluoride-Free | Real Skin Care',  // 55 chars
    metaDescription: 'A'.repeat(150),
    bodyHtml: '<p>' + Array(150).fill('word').join(' ') + '</p>',
    metafieldOverrides: {},
  };
  const mockClient = { messages: { create: async () => fakeClaudeResponse(validProductOutput) } };

  const item = await assembleProduct({
    foundation,
    clusterName: 'toothpaste',
    product: { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste' },
    claudeClient: mockClient,
  });

  assert.equal(item.type, 'pdp-product');
  assert.equal(item.status, 'pending');
  assert.equal(item.proposed.seoTitle.length, 55);
});
