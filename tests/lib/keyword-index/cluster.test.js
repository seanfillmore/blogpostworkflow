import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignCluster } from '../../../lib/keyword-index/cluster.js';

test('assigns product categories from keyword text', () => {
  assert.equal(assignCluster('best natural deodorant for women'), 'deodorant');
  assert.equal(assignCluster('aluminum free deodorant'), 'deodorant');
  assert.equal(assignCluster('fluoride free toothpaste'), 'toothpaste');
  assert.equal(assignCluster('sls free toothpaste for sensitive teeth'), 'toothpaste');
  assert.equal(assignCluster('best natural lip balm for dry chapped lips'), 'lip balm');
  assert.equal(assignCluster('natural bar soap for men'), 'soap');
  assert.equal(assignCluster('best soap for tattoos'), 'soap');
  assert.equal(assignCluster('best body lotion for sensitive skin'), 'lotion');
  assert.equal(assignCluster('best body cream for sensitive skin 2025 2026'), 'lotion');
});

test('product type beats the generic coconut-oil cluster', () => {
  assert.equal(assignCluster('coconut oil lotion for dry skin'), 'lotion');
  assert.equal(assignCluster('coconut oil for hair benefits'), 'hair');
  // bare ingredient queries fall to the coconut-oil cluster
  assert.equal(assignCluster('benefits of coconut oil for skin'), 'coconut oil');
  assert.equal(assignCluster('is coconut oil good for your face'), 'coconut oil');
});

test('body wash → soap, body lotion → lotion (not confused)', () => {
  assert.equal(assignCluster('natural body wash'), 'soap');
  assert.equal(assignCluster('best natural body lotion'), 'lotion');
});

test('branded / navigational queries map to the brand cluster', () => {
  assert.equal(assignCluster('real skin care'), 'brand');
  assert.equal(assignCluster('realskincare'), 'brand');
  assert.equal(assignCluster('the real skin care products'), 'brand');
  // generic "skin care" is NOT branded
  assert.equal(assignCluster('natural skin care'), 'unclustered');
});

test('genuinely off-topic / empty queries stay unclustered', () => {
  assert.equal(assignCluster('skin care company'), 'unclustered');
  assert.equal(assignCluster(''), 'unclustered');
  assert.equal(assignCluster(null), 'unclustered');
});
