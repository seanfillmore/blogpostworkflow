// tests/agents/pdp-builder/assemble-cluster.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFoundation } from '../../../agents/pdp-builder/lib/load-foundation.js';
import { assembleCluster } from '../../../agents/pdp-builder/lib/assemble-cluster.js';

const foundation = loadFoundation();

// Build a Claude-shaped response that the agent will parse.
function fakeClaudeResponse(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

const VALID_CLUSTER_OUTPUT = {
  hookLine: 'For sensitive teeth, less in the formula means more for your enamel.',
  ingredientCards: [
    {
      name: 'Organic Virgin Coconut Oil',
      role: 'antimicrobial base',
      story: Array(50).fill('word').join(' '),
    },
    {
      name: 'Baking Soda',
      role: 'pH balancer',
      story: Array(50).fill('word').join(' '),
    },
    {
      name: 'Wildcrafted Myrrh Powder',
      role: 'anti-inflammatory',
      story: Array(50).fill('word').join(' '),
    },
  ],
  mechanismBlock: Array(90).fill('word').join(' '),
  founderBlock: Array(70).fill('word').join(' '),
  freeFrom: ['No SLS', 'No fluoride', 'No synthetic flavors', 'No glycerin coating'],
  faq: Array.from({ length: 7 }, (_, i) => ({
    question: `Q${i+1}?`,
    answer: Array(50).fill('word').join(' '),
  })),
  badges: ['Vegan', 'Cruelty-Free', 'Made in USA', 'Small Batch'],
  guarantees: ['30-day MBG', 'Free shipping over $50', 'Clean ingredients', 'Handcrafted'],
};

test('assembleCluster: returns queue item with status pending when validation passes', async () => {
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(VALID_CLUSTER_OUTPUT) },
  };
  const result = await assembleCluster({
    foundation,
    clusterName: 'toothpaste',
    claudeClient: mockClient,
  });
  assert.equal(result.type, 'pdp-cluster');
  assert.equal(result.slug, 'toothpaste');
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.proposed.ingredientCards.map((c) => c.name).sort(),
    ['Baking Soda', 'Organic Virgin Coconut Oil', 'Wildcrafted Myrrh Powder'].sort());
  assert.equal(result.validation.passed, true);
});

test('assembleCluster: returns queue item with status needs_rework when ingredient fabricated', async () => {
  const fabricatedOutput = {
    ...VALID_CLUSTER_OUTPUT,
    ingredientCards: [
      ...VALID_CLUSTER_OUTPUT.ingredientCards.slice(0, 2),
      { name: 'Hydroxyapatite', role: 'remineralizer', story: Array(50).fill('w').join(' ') },
    ],
  };
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(fabricatedOutput) },
  };
  const result = await assembleCluster({
    foundation,
    clusterName: 'toothpaste',
    claudeClient: mockClient,
  });
  assert.equal(result.status, 'needs_rework');
  assert.equal(result.validation.passed, false);
  assert.match(JSON.stringify(result.validation.errors), /hydroxyapatite/i);
});

test('assembleCluster: returns needs_rework when length out of bounds', async () => {
  const tooShortOutput = {
    ...VALID_CLUSTER_OUTPUT,
    mechanismBlock: 'just a few words',
  };
  const mockClient = {
    messages: { create: async () => fakeClaudeResponse(tooShortOutput) },
  };
  const result = await assembleCluster({
    foundation,
    clusterName: 'toothpaste',
    claudeClient: mockClient,
  });
  assert.equal(result.status, 'needs_rework');
});
