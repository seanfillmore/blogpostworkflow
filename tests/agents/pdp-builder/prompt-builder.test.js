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

test('buildClusterSystemPrompt: includes ingredient stories for the cluster', () => {
  const prompt = buildClusterSystemPrompt({ foundation, clusterName: 'toothpaste' });
  assert.match(prompt, /organic virgin coconut oil/i);
  assert.match(prompt, /wildcrafted myrrh/i);
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
