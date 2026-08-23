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

// The toothpaste rule's `cavit` alternative used to be followed directly by a
// trailing \b, which requires a non-word character right after whatever matched.
// No real query is ever the bare token "cavit" — it only ever appears inside
// "cavity"/"cavities"/"cavitation" — so that \b could never be satisfied and the
// alternative was dead code. A query naming cavities but no OTHER toothpaste term
// (no "toothpaste"/"fluoride"/"tooth"/etc.) fell all the way through to the
// coconut-oil bucket instead, e.g. "is coconut oil good for cavities" — a real
// leak-report query — mis-clustered as 'coconut oil' (skin, ~$0 revenue toothpaste
// vs skin cluster mislabeling either way) instead of 'toothpaste'.
test('cavity/cavities/cavitation match the toothpaste cluster, even with no other toothpaste term present', () => {
  assert.equal(assignCluster('is coconut oil good for cavities'), 'toothpaste');
  assert.equal(assignCluster('does coconut oil cause cavities'), 'toothpaste');
  assert.equal(assignCluster('coconut oil cavity prevention'), 'toothpaste');
  assert.equal(assignCluster('how to prevent cavities naturally'), 'toothpaste');
  assert.equal(assignCluster('cavity'), 'toothpaste');
  assert.equal(assignCluster('cavities'), 'toothpaste');
  assert.equal(assignCluster('tooth cavitation'), 'toothpaste');
});

// The \w*-based fix must still respect the leading \b: "cavit" embedded inside a
// larger unrelated word with no boundary in front of it (no real English word does
// this, but this pins that the fix didn't loosen the front edge) must not match.
test('the cavit fix does not introduce false positives on words that merely contain the substring', () => {
  assert.equal(assignCluster('concavity of a lens'), 'unclustered');
  assert.equal(assignCluster('excavation site'), 'unclustered');
});

// ── plurals ───────────────────────────────────────────────────────────────────
// `\b` after a bare noun requires a non-word character right after it, so
// `\bsoap\b` never matched "soaps" and `\btattoo\b` never matched "tattoos".
// Nine live calendar items — the whole tattoo-soap group, e.g. "best soaps for
// tattoos" — matched NO rule at all and dropped out of the evidence pool the
// $0-cluster verdict is computed over. This is the same class of bug as the
// dead `cavit` stem documented above the toothpaste rule.

test('a plural product noun lands in its cluster', () => {
  assert.equal(assignCluster('best soaps for tattoos'), 'soap');
  assert.equal(assignCluster('what soap to use for tattoos'), 'soap');
  assert.equal(assignCluster('natural deodorants for men'), 'deodorant');
  assert.equal(assignCluster('best lip balms 2026'), 'lip balm');
  assert.equal(assignCluster('fluoride free toothpastes'), 'toothpaste');
  assert.equal(assignCluster('best shampoos'), 'hair');
  assert.equal(assignCluster('natural body washes'), 'soap');
});

test('a plural does not steal a query from an earlier rule', () => {
  // Ordering still decides: soap precedes lotion precedes coconut oil.
  assert.equal(assignCluster('coconut soaps'), 'soap');
  assert.equal(assignCluster('coconut oil deodorants'), 'deodorant');
  assert.equal(assignCluster('coconut oil'), 'coconut oil');
});
