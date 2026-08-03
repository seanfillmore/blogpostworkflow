// tests/config/deodorant-4-pack.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL_FIX, assertOnlySpelling } from '../../data/brand/frames/deodorant-4-pack/d4-frames.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
const b = bundles.find((x) => x.handle === 'coconut-deodorant-4-pack');
const ing = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

test('every variant is a genuine four-pack at one price', () => {
  for (const v of b.variants) {
    const units = v.components.reduce((a, c) => a + c.qty, 0);
    assert.equal(units, 4, `${v.options.Scent} holds ${units}, not 4`);
    assert.equal(v.price, b.variants[0].price, 'the frames print one price for every scent');
    assert.ok(v.price / units < 15, `$${v.price}/${units} is at or above the $15 ceiling frame 2 is built on`);
  }
});

test('LABEL_FIX only ever corrects spelling', () => {
  // It exists because the Shopify option says "Frankincence" while the product's
  // own label says "frankincense". It must not become a way to re-title products.
  assert.ok(Object.keys(LABEL_FIX).length <= 2, 'LABEL_FIX is growing beyond a typo correction');
  for (const [from, to] of Object.entries(LABEL_FIX)) {
    assert.doesNotThrow(() => assertOnlySpelling(from, to), `${from} → ${to} is not a spelling fix`);
  }
  // And the guard must actually reject a re-title.
  assert.throws(() => assertOnlySpelling('Wildcrafted Frankincence', 'Something Else Entirely Here'));
});

test('the aluminium-free claim is true of the deodorant', () => {
  const all = [...ing.deodorant.base_ingredients,
    ...(ing.deodorant.variations ?? []).flatMap((v) => v.essential_oils ?? [])].join(' ').toLowerCase();
  for (const t of ['aluminium', 'aluminum']) {
    assert.ok(!all.includes(t), `the SEO title claims aluminium-free but "${t}" is in the formulation`);
  }
});

console.log('✓ deodorant-4-pack tests pass');
