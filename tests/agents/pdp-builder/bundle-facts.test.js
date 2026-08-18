// tests/agents/pdp-builder/bundle-facts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBundleFacts,
  canonicalScent,
  clusterIndexByHandle,
  allowedMoneyFigures,
  allowedPercentFigures,
} from '../../../agents/pdp-builder/lib/bundle-facts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const INGREDIENTS = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

function component(qty, handle, title, price, productTitle = 'X') {
  return {
    quantity: qty,
    productVariant: { id: 'gid://v', title, price: String(price), product: { id: 'gid://p', title: productTitle, handle } },
  };
}

// Mirrors the live clean-swap "Gentle" variant, verified against Shopify.
const CLEAN_SWAP = {
  handle: 'clean-swap',
  title: 'The Clean Swap',
  status: 'ACTIVE',
  productType: '',
  tags: ['bundle'],
  variants: {
    nodes: [{
      id: 'gid://v1',
      title: 'Gentle',
      price: '59.00',
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

test('buildBundleFacts: computes savings from live component prices', () => {
  const facts = buildBundleFacts({ product: CLEAN_SWAP, ingredientsByCluster: INGREDIENTS });
  const v = facts.variants[0];
  assert.equal(v.price, 59);
  assert.equal(v.partsTotal, 69);   // 30 + 15 + 13 + 11
  assert.equal(v.savings, 10);
  assert.equal(v.savingsPct, 14);   // round(10/69*100)
  assert.equal(v.unitCount, 4);
  assert.equal(v.pricePerUnit, 14.75);
  assert.equal(facts.savings.claimable, true);
  assert.equal(facts.savings.uniform, true);
  assert.deepEqual(
    [...facts.clusters].sort(),
    ['bar_soap', 'deodorant', 'lotion', 'toothpaste'],
  );
});

test('buildBundleFacts: savings not claimable when a variant costs more than its parts', () => {
  const overpriced = structuredClone(CLEAN_SWAP);
  overpriced.variants.nodes[0].price = '75.00';
  const facts = buildBundleFacts({ product: overpriced, ingredientsByCluster: INGREDIENTS });
  assert.equal(facts.variants[0].savings, -6);
  assert.equal(facts.savings.claimable, false);
});

test('buildBundleFacts: savings not claimable when a bundle exactly equals its parts', () => {
  const even = structuredClone(CLEAN_SWAP);
  even.variants.nodes[0].price = '69.00';
  const facts = buildBundleFacts({ product: even, ingredientsByCluster: INGREDIENTS });
  assert.equal(facts.variants[0].savings, 0);
  assert.equal(facts.savings.claimable, false);
});

test('buildBundleFacts: quantity is multiplied, not counted once', () => {
  const threePack = {
    handle: 'coconut-toothpaste-3-pack',
    title: 'Coconut Oil Toothpaste — 3-Pack',
    status: 'DRAFT',
    variants: {
      nodes: [{
        id: 'gid://v', title: '3x Fresh Mint', price: '34.00',
        productVariantComponents: { nodes: [component(3, 'coconut-oil-toothpaste', 'Fresh Mint', 13)] },
      }],
    },
  };
  const facts = buildBundleFacts({ product: threePack, ingredientsByCluster: INGREDIENTS });
  assert.equal(facts.variants[0].partsTotal, 39);
  assert.equal(facts.variants[0].savings, 5);
  assert.equal(facts.variants[0].unitCount, 3);
});

test('buildBundleFacts: throws on a component product missing from config/ingredients.json', () => {
  const bogus = structuredClone(CLEAN_SWAP);
  bogus.variants.nodes[0].productVariantComponents.nodes.push(
    component(1, 'mystery-serum', 'Default', 20),
  );
  assert.throws(
    () => buildBundleFacts({ product: bogus, ingredientsByCluster: INGREDIENTS }),
    /mystery-serum.*not in config\/ingredients\.json/s,
  );
});

test('buildBundleFacts: throws when a variant has no bundle components', () => {
  const plain = structuredClone(CLEAN_SWAP);
  plain.variants.nodes[0].productVariantComponents.nodes = [];
  assert.throws(() => buildBundleFacts({ product: plain, ingredientsByCluster: INGREDIENTS }), /not a Shopify bundle variant/);
});

// The Shopify option value was corrected to "Frankincense" on 2026-08-18, and
// config/ingredients.json's `shopify_option` was corrected with it. This test is
// deliberately KEPT: the typo is still reachable — historical orders keep their
// old line-item titles, and generated artifacts such as
// data/bundles/descriptions/coconut-deodorant-4-pack.json were written while
// Shopify still held it. What changed is which branch resolves it. It used to hit
// the exact-match on `shopify_option`; that entry is gone, so it now falls
// through to the Levenshtein arm ("cence" → "cense" is distance 1). Both arms
// must keep working, so the assertion is unchanged.
test('canonicalScent: still resolves the historical "Frankincence" misspelling', () => {
  const { name, corrected } = canonicalScent('Wildcrafted Frankincence', INGREDIENTS.deodorant);
  assert.equal(name, 'Wildcrafted Frankincense');
  assert.deepEqual(corrected, { from: 'Wildcrafted Frankincence', to: 'Wildcrafted Frankincense' });
});

test('canonicalScent: the corrected live spelling needs no correction', () => {
  // The post-rename reality: what Shopify now sends must pass through untouched,
  // so pdp-builder stops reporting a correction that no longer exists.
  const { name, corrected } = canonicalScent('Wildcrafted Frankincense', INGREDIENTS.deodorant);
  assert.equal(name, 'Wildcrafted Frankincense');
  assert.equal(corrected, null);
});

test('canonicalScent: leaves an exact match alone and reports no correction', () => {
  const { name, corrected } = canonicalScent('Calming Lavender', INGREDIENTS.deodorant);
  assert.equal(name, 'Calming Lavender');
  assert.equal(corrected, null);
});

test('canonicalScent: does not "correct" a genuinely different name', () => {
  const { name, corrected } = canonicalScent('Smoked Bergamot', INGREDIENTS.deodorant);
  assert.equal(name, 'Smoked Bergamot');
  assert.equal(corrected, null);
});

// Fixture titles keep the OLD spelling on purpose — this is the stale-data path
// (historical orders, artifacts generated before the 2026-08-18 rename), which is
// exactly the case scentCorrections exists to surface.
test('buildBundleFacts: surfaces scent corrections on the facts', () => {
  const deo = {
    handle: 'coconut-deodorant-4-pack',
    title: 'Coconut Deodorant — 4-Pack',
    status: 'DRAFT',
    variants: {
      nodes: [{
        id: 'gid://v', title: '4x Wildcrafted Frankincence', price: '53.00',
        productVariantComponents: { nodes: [component(4, 'coconut-oil-deodorant', 'Wildcrafted Frankincence', 15)] },
      }],
    },
  };
  const facts = buildBundleFacts({ product: deo, ingredientsByCluster: INGREDIENTS });
  assert.equal(facts.variants[0].components[0].scent, 'Wildcrafted Frankincense');
  assert.equal(facts.variants[0].components[0].shopifyVariantTitle, 'Wildcrafted Frankincence');
  assert.equal(facts.scentCorrections.length, 1);
});

test('clusterIndexByHandle: derives the map from config, not a hardcoded table', () => {
  const idx = clusterIndexByHandle(INGREDIENTS);
  assert.equal(idx['coconut-lotion'], 'lotion');
  assert.equal(idx['organic-foaming-hand-soap'], 'liquid_soap');
  assert.equal(idx['coconut-soap'], 'bar_soap');
});

test('allowedMoneyFigures / allowedPercentFigures: exactly the derivable numbers', () => {
  const facts = buildBundleFacts({ product: CLEAN_SWAP, ingredientsByCluster: INGREDIENTS });
  const money = allowedMoneyFigures(facts);
  for (const n of [59, 69, 10, 14.75, 30, 15, 13, 11]) assert.ok(money.has(n), `expected $${n} allowed`);
  assert.ok(!money.has(20), '$20 is not derivable and must not be allowed');
  assert.deepEqual([...allowedPercentFigures(facts)], [14]);
});

test('allowedPercentFigures: empty when savings are not claimable', () => {
  const overpriced = structuredClone(CLEAN_SWAP);
  overpriced.variants.nodes[0].price = '75.00';
  const facts = buildBundleFacts({ product: overpriced, ingredientsByCluster: INGREDIENTS });
  assert.equal(allowedPercentFigures(facts).size, 0);
});
