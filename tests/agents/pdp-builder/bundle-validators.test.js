// tests/agents/pdp-builder/bundle-validators.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundleFacts } from '../../../agents/pdp-builder/lib/bundle-facts.js';
import {
  validateBundleLengths,
  validateNoHealthClaims,
  validateBundleComponents,
  validateNoFabricatedSizes,
  validateSavingsClaim,
  validateLengths,
} from '../../../agents/pdp-builder/lib/validators.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const INGREDIENTS = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

function component(qty, handle, title, price) {
  return {
    quantity: qty,
    productVariant: { id: 'gid://v', title, price: String(price), product: { id: 'gid://p', title: 'X', handle } },
  };
}

const CLEAN_SWAP = {
  handle: 'clean-swap', title: 'The Clean Swap', status: 'ACTIVE',
  variants: {
    nodes: [{
      id: 'gid://v1', title: 'Gentle', price: '59.00',
      productVariantComponents: {
        nodes: [
          component(1, 'coconut-lotion', 'Pure Unscented', 30),
          component(1, 'coconut-oil-deodorant', 'Calming Lavender', 15),
          component(1, 'coconut-oil-toothpaste', 'Fresh Mint', 13),
          component(1, 'coconut-soap', 'Pure Unscented', 11),
        ],
      },
    }],
  },
};
const facts = buildBundleFacts({ product: CLEAN_SWAP, ingredientsByCluster: INGREDIENTS });

// ── validateBundleLengths ──────────────────────────────────────────────────

test('validateBundleLengths: accepts a bundle-sized body', () => {
  const body = '<p>' + Array(200).fill('word').join(' ') + '</p>';
  assert.equal(validateBundleLengths({ bodyHtml: body }).valid, true);
});

test('validateBundleLengths: rejects a body below 150 words', () => {
  const body = '<p>' + Array(100).fill('word').join(' ') + '</p>';
  const r = validateBundleLengths({ bodyHtml: body });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /100 words outside 150-320/);
});

test('validateBundleLengths: rejects a body above 320 words', () => {
  const body = '<p>' + Array(400).fill('word').join(' ') + '</p>';
  assert.equal(validateBundleLengths({ bodyHtml: body }).valid, false);
});

test('bundle mode does not weaken the shared seoTitle/metaDescription bounds', () => {
  // Regression guard: adding bundle mode must not have relaxed product-mode bounds.
  const tooLong = validateLengths({ seoTitle: 'X'.repeat(80), metaDescription: 'A'.repeat(150) });
  assert.equal(tooLong.valid, false);
  // Bounds are measured on the RENDERED title since 2026-09-06, so a passing
  // fixture has to carry the brand exactly as the prompt's mandated format does
  // — 43 + " | Real Skin Care" = 60, with nothing appended by the theme.
  const ok = validateLengths({ seoTitle: `${'X'.repeat(43)} | Real Skin Care`, metaDescription: 'A'.repeat(150) });
  assert.equal(ok.valid, true);
});

// ── validateNoHealthClaims ─────────────────────────────────────────────────

test('validateNoHealthClaims: clean cosmetic language passes', () => {
  const r = validateNoHealthClaims({
    text: '<p>Moisturizes dry, sensitive skin and absorbs without a greasy film.</p>',
    field: 'bodyHtml',
  });
  assert.deepEqual(r, { valid: true, errors: [] });
});

test('validateNoHealthClaims: a disease name is rejected', () => {
  const r = validateNoHealthClaims({ text: 'Gentle enough for eczema-prone skin.', field: 'bodyHtml' });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /health claim "eczema" \(disease\)/);
});

test('validateNoHealthClaims: a therapeutic verb is rejected even when benign-sounding', () => {
  const r = validateNoHealthClaims({ text: 'Prevents winter dryness all season.', field: 'bodyHtml' });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /therapeutic/);
});

test('validateNoHealthClaims: a drug reference is rejected', () => {
  const r = validateNoHealthClaims({ text: 'Better than prescription lotion.', field: 'bodyHtml' });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /drug/);
});

test('validateNoHealthClaims: substantiation language is rejected', () => {
  const r = validateNoHealthClaims({ text: 'Dermatologist tested and approved.', field: 'seoTitle' });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /substantiation/);
});

test('validateNoHealthClaims: sees through HTML tags', () => {
  const r = validateNoHealthClaims({ text: '<p>It <strong>heals</strong> skin.</p>', field: 'bodyHtml' });
  assert.equal(r.valid, false);
});

test('validateNoHealthClaims: word boundaries hold — "healthy" and "manicure" pass', () => {
  const r = validateNoHealthClaims({ text: 'Healthy-looking skin after a manicure.', field: 'bodyHtml' });
  assert.equal(r.valid, true);
});

// ── validateBundleComponents ───────────────────────────────────────────────

test('validateBundleComponents: accepts copy naming only real components', () => {
  const text = '<p>Body lotion, deodorant, toothpaste and bar soap. Pure Unscented or Calming Lavender.</p>';
  assert.equal(validateBundleComponents({ text, facts, ingredientsByCluster: INGREDIENTS }).valid, true);
});

test('validateBundleComponents: rejects a component the bundle does not contain', () => {
  const text = '<p>Body lotion, deodorant, toothpaste, bar soap and a lip balm.</p>';
  const r = validateBundleComponents({ text, facts, ingredientsByCluster: INGREDIENTS });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /claims component "lip balm" \(lip_balm\) that is not in clean-swap/);
});

test('validateBundleComponents: rejects a scent this bundle does not ship', () => {
  const text = '<p>Choose Rose Petal or Pure Unscented.</p>';
  const r = validateBundleComponents({ text, facts, ingredientsByCluster: INGREDIENTS });
  assert.equal(r.valid, false);
  assert.match(r.errors.join('\n'), /names scent "Rose Petal"/);
});

test('validateBundleComponents: lowercase ingredient prose does not false-fire on a scent name', () => {
  const text = '<p>Organic essential oil of lavender gives it a soft finish.</p>';
  assert.equal(validateBundleComponents({ text, facts, ingredientsByCluster: INGREDIENTS }).valid, true);
});

// ── validateNoFabricatedSizes ──────────────────────────────────────────────

const SIZED = buildBundleFacts({
  ingredientsByCluster: INGREDIENTS,
  product: {
    handle: 'gift-box', title: 'Gift Box', status: 'ACTIVE',
    variants: {
      nodes: [{
        id: 'gid://v', title: 'Gentle', price: '62.00',
        productVariantComponents: {
          nodes: [
            { quantity: 1, productVariant: { title: 'Pure Unscented', price: '11.00', product: { title: 'Moisturizing Coconut Soap | 3.4oz', handle: 'coconut-soap' } } },
            { quantity: 1, productVariant: { title: 'Calming Lavender', price: '15.00', product: { title: 'Best Coconut Oil Deodorant | 2oz', handle: 'coconut-oil-deodorant' } } },
          ],
        },
      }],
    },
  },
});

test('validateNoFabricatedSizes: accepts sizes carried by the Shopify product titles', () => {
  const text = '<p>One 3.4oz bar and one 2 oz roll-on.</p>';
  assert.equal(validateNoFabricatedSizes({ text, facts: SIZED }).valid, true);
});

test('validateNoFabricatedSizes: "fl oz" is not treated as a different unit', () => {
  assert.equal(validateNoFabricatedSizes({ text: '<p>A 3.4 fl oz bar.</p>', facts: SIZED }).valid, true);
});

test('validateNoFabricatedSizes: rejects a size no component title carries', () => {
  const r = validateNoFabricatedSizes({ text: '<p>A 4 fl oz squeeze bottle.</p>', facts: SIZED });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /states size "4 oz"/);
});

test('validateNoFabricatedSizes: copy with no size at all passes', () => {
  assert.equal(validateNoFabricatedSizes({ text: '<p>A bar and a roll-on.</p>', facts: SIZED }).valid, true);
});

// ── validateSavingsClaim ───────────────────────────────────────────────────

test('validateSavingsClaim: accepts figures the arithmetic produces', () => {
  const text = '<p>$69 of product for $59. That is $10 back in your pocket.</p>';
  assert.equal(validateSavingsClaim({ text, facts }).valid, true);
});

test('validateSavingsClaim: rejects an invented saving', () => {
  const text = '<p>Save $25 against buying singly.</p>';
  const r = validateSavingsClaim({ text, facts });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /\$25.*not derivable/);
});

test('validateSavingsClaim: rejects a percentage that is not the computed one', () => {
  const text = '<p>Save 30% today.</p>';
  const r = validateSavingsClaim({ text, facts });
  assert.equal(r.valid, false);
  assert.match(r.errors.join('\n'), /"30%" is not a computed savings figure/);
});

test('validateSavingsClaim: accepts the computed percentage', () => {
  assert.equal(validateSavingsClaim({ text: '<p>About 14% off buying singly.</p>', facts }).valid, true);
});

test('validateSavingsClaim: forbids ALL savings language when the bundle is not cheaper', () => {
  const overpriced = structuredClone(CLEAN_SWAP);
  overpriced.variants.nodes[0].price = '75.00';
  const badFacts = buildBundleFacts({ product: overpriced, ingredientsByCluster: INGREDIENTS });
  const r = validateSavingsClaim({ text: '<p>Save when you buy the set.</p>', facts: badFacts });
  assert.equal(r.valid, false);
  assert.match(r.errors.join('\n'), /not cheaper than the sum of its parts/);
});

test('validateSavingsClaim: a non-cheaper bundle may still describe itself without price language', () => {
  const overpriced = structuredClone(CLEAN_SWAP);
  overpriced.variants.nodes[0].price = '75.00';
  const badFacts = buildBundleFacts({ product: overpriced, ingredientsByCluster: INGREDIENTS });
  const r = validateSavingsClaim({ text: '<p>Everything you use daily, in one box.</p>', facts: badFacts });
  assert.equal(r.valid, true);
});
