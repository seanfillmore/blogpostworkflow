// tests/agents/pdp-builder/validators.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIngredients,
  validateLengths,
  validateBrandTermExclusion,
  validateNoFabricatedIngredients,
} from '../../../agents/pdp-builder/lib/validators.js';

// Mock cluster ingredient list (mirrors what load-foundation produces from config/ingredients.json)
const TOOTHPASTE_INGREDIENTS = {
  toothpaste: {
    base_ingredients: [
      'purified spring water',
      'organic virgin coconut oil',
      'baking soda',
      'xanthan gum',
      'wildcrafted myrrh powder',
      'stevia',
    ],
    variations: [
      { essential_oils: ['organic essential oil of peppermint', 'organic essential oil of spearmint'] },
    ],
  },
};

// ── validateIngredients ──────────────────────────────────────────────

test('validateIngredients: passes when every claimed ingredient is in the cluster spec', () => {
  const result = validateIngredients({
    cluster: 'toothpaste',
    claimedIngredients: ['organic virgin coconut oil', 'baking soda', 'wildcrafted myrrh powder'],
    ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.fabricated, []);
});

test('validateIngredients: rejects fabricated ingredients', () => {
  const result = validateIngredients({
    cluster: 'toothpaste',
    claimedIngredients: ['hydroxyapatite', 'baking soda'],  // hydroxyapatite is not in the spec
    ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.fabricated, ['hydroxyapatite']);
});

test('validateIngredients: case-insensitive', () => {
  const result = validateIngredients({
    cluster: 'toothpaste',
    claimedIngredients: ['Organic Virgin Coconut Oil', 'BAKING SODA'],
    ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
  });
  assert.equal(result.valid, true);
});

test('validateIngredients: matches essential oils from variations', () => {
  const result = validateIngredients({
    cluster: 'toothpaste',
    claimedIngredients: ['organic essential oil of peppermint'],
    ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
  });
  assert.equal(result.valid, true);
});

test('validateIngredients: throws when cluster missing from ingredientsByCluster', () => {
  assert.throws(
    () => validateIngredients({
      cluster: 'unknown-cluster',
      claimedIngredients: ['anything'],
      ingredientsByCluster: TOOTHPASTE_INGREDIENTS,
    }),
    /unknown-cluster/,
  );
});

// ── validateLengths ──────────────────────────────────────────────────

test('validateLengths: SEO title 55-70 chars passes', () => {
  const result = validateLengths({
    seoTitle: 'Coconut Oil Toothpaste | Fluoride-Free | Real Skin Care',  // 55 chars
  });
  assert.equal(result.valid, true);
});

test('validateLengths: SEO title 80 chars fails', () => {
  const result = validateLengths({
    seoTitle: 'X'.repeat(80),
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /seoTitle.*80.*70/);
});

test('validateLengths: meta description 145-160 chars passes', () => {
  const result = validateLengths({
    metaDescription: 'A'.repeat(150),
  });
  assert.equal(result.valid, true);
});

test('validateLengths: meta description 200 chars fails', () => {
  const result = validateLengths({
    metaDescription: 'A'.repeat(200),
  });
  assert.equal(result.valid, false);
});

test('validateLengths: ingredient story word count 40-60 passes', () => {
  const story = Array(50).fill('word').join(' ');
  const result = validateLengths({
    ingredientCards: [{ name: 'X', story }],
  });
  assert.equal(result.valid, true);
});

test('validateLengths: ingredient story 100 words fails', () => {
  const story = Array(100).fill('word').join(' ');
  const result = validateLengths({
    ingredientCards: [{ name: 'X', story }],
  });
  assert.equal(result.valid, false);
});

// ── validateBrandTermExclusion ───────────────────────────────────────

test('validateBrandTermExclusion: passes for clean keyword', () => {
  const result = validateBrandTermExclusion({
    text: 'Coconut Oil Toothpaste | Fluoride-Free | Real Skin Care',
    field: 'seoTitle',
  });
  assert.equal(result.valid, true);
});

test('validateBrandTermExclusion: rejects competitor brand in body_html', () => {
  const result = validateBrandTermExclusion({
    text: 'Better than Tom\'s of Maine and gentler than Schmidt\'s.',
    field: 'bodyHtml',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /tom's of maine|schmidt/i);
});

test('validateBrandTermExclusion: rejects generic-blocklist term in seoTitle', () => {
  const result = validateBrandTermExclusion({
    text: 'Authentic Skincare Products',
    field: 'seoTitle',
  });
  assert.equal(result.valid, false);
});

test('validateBrandTermExclusion: allows brand_terms in seoTitle (it IS our brand)', () => {
  // BRAND_TERMS like "real skin care" are allowed in our own product titles.
  // Only competitor and generic terms are blocked.
  const result = validateBrandTermExclusion({
    text: 'Coconut Oil Toothpaste | Real Skin Care',
    field: 'seoTitle',
  });
  assert.equal(result.valid, true);
});

// ── validateNoFabricatedIngredients (product-mode prose scan) ─────────

test('validateNoFabricatedIngredients: passes for clean prose', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Made with organic virgin coconut oil and baking soda.</p>',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.flagged, []);
});

test('validateNoFabricatedIngredients: flags fluoride mentioned as a positive claim', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Strengthens enamel with fluoride for cavity protection.</p>',
  });
  assert.equal(result.valid, false);
  assert.ok(result.flagged.some((f) => f.term === 'fluoride'));
});

test('validateNoFabricatedIngredients: allows fluoride-free as a brand claim', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Our fluoride-free formula is gentle on sensitive teeth.</p>',
  });
  assert.equal(result.valid, true);
});

test('validateNoFabricatedIngredients: allows "no fluoride" as a brand claim', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Made with no fluoride and no synthetic sweeteners.</p>',
  });
  assert.equal(result.valid, true);
});

test('validateNoFabricatedIngredients: allows "without fluoride" as a brand claim', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Cleans deeply without fluoride or harsh abrasives.</p>',
  });
  assert.equal(result.valid, true);
});

test('validateNoFabricatedIngredients: flags hydroxyapatite (premium fabrication risk)', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Contains hydroxyapatite to remineralize enamel naturally.</p>',
  });
  assert.equal(result.valid, false);
  assert.ok(result.flagged.some((f) => f.term === 'hydroxyapatite'));
});

test('validateNoFabricatedIngredients: flags PEG-40 (catches peg- prefix)', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Emulsified with PEG-40 hydrogenated castor oil.</p>',
  });
  assert.equal(result.valid, false);
  assert.ok(result.flagged.some((f) => f.term === 'peg-'));
});

test('validateNoFabricatedIngredients: strips HTML before scanning', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Pure formula with <strong>no parabens</strong> ever.</p>',
  });
  assert.equal(result.valid, true);
});

test('validateNoFabricatedIngredients: case-insensitive', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Contains FLUORIDE for protection.</p>',
  });
  assert.equal(result.valid, false);
});

test('validateNoFabricatedIngredients: returns flagged array with term, sentence-context info', () => {
  const result = validateNoFabricatedIngredients({
    text: '<p>Contains hydroxyapatite to remineralize enamel.</p>',
  });
  assert.equal(result.valid, false);
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].term, 'hydroxyapatite');
  assert.ok(typeof result.flagged[0].context === 'string');
  assert.ok(result.flagged[0].context.length > 0);
});
