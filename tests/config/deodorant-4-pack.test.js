// tests/config/deodorant-4-pack.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_SLUG, assertOnlySpelling, packFrame, valueFrame } from '../../data/brand/frames/deodorant-4-pack/d4-frames.mjs';

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

// ── LEGACY_SLUG (replaced LABEL_FIX on 2026-08-18) ──────────────────────────
// LABEL_FIX corrected the misspelled Shopify option value on its way into a
// caption. The option value was corrected in Shopify, so that map became a
// no-op and was retired. What survives is the opposite mapping: the ARTIFACTS
// are still named after the old spelling, and must stay that way until a single
// change re-renders, re-uploads and re-keys them together. These tests guard the
// two ways that pin can silently rot.

test('LEGACY_SLUG only ever pins a spelling difference', () => {
  assert.ok(Object.keys(LEGACY_SLUG).length <= 2, 'LEGACY_SLUG is growing beyond a typo pin');
  for (const [from, to] of Object.entries(LEGACY_SLUG)) {
    assert.doesNotThrow(() => assertOnlySpelling(from, to), `${from} → ${to} is not a spelling difference`);
  }
  // And the guard must actually reject pointing a frame at an unrelated asset.
  assert.throws(() => assertOnlySpelling('wildcrafted-frankincense', 'something-else-entirely-here'));
});

test('every pinned slug names a cutout that exists on disk', () => {
  // d4-frames.mjs opens data/brand/cutouts/component-deodorant-<slug>.png. If the
  // pin and the file ever disagree the frame throws ENOENT at render time, and
  // nothing else in the suite covers this product's cutouts.
  for (const slug of Object.values(LEGACY_SLUG)) {
    const png = join(ROOT, 'data', 'brand', 'cutouts', `component-deodorant-${slug}.png`);
    if (slug.startsWith('4x-')) continue; // pack slugs name frames, not cutouts
    assert.ok(existsSync(png), `LEGACY_SLUG pins "${slug}" but ${png} does not exist`);
  }
});

test('frame names match the media-scope keys exactly', () => {
  // scripts/set-media-variant-scope.mjs keys on a FILENAME FRAGMENT. A frame whose
  // name drifts from its scope key is not a loud failure: the media it should have
  // described falls out of the scope file, which STRIPS that media's suffix and
  // renders it for no variant at all. This is the check that catches the drift.
  const scope = JSON.parse(readFileSync(
    join(ROOT, 'data', 'brand', 'bundle-images', 'coconut-deodorant-4-pack.scope.json'), 'utf8'));
  const scents = b.variants.map((v) => v.options.Scent);
  const built = [...scents.map((s) => packFrame(s).name), ...scents.map((s) => valueFrame(s).name)];
  assert.deepEqual(built.slice().sort(), Object.keys(scope.scope).slice().sort(),
    'the frames the builders emit are not the frames the scope file describes');
});

test('media-scope values are live Scent option values', () => {
  // A scope value that is not a real option value makes the theme hide that image
  // for EVERY variant. set-media-variant-scope.mjs throws on it, but only when
  // someone remembers to run it; config/bundles.json mirrors Shopify, so compare here.
  const scope = JSON.parse(readFileSync(
    join(ROOT, 'data', 'brand', 'bundle-images', 'coconut-deodorant-4-pack.scope.json'), 'utf8'));
  const values = new Set(b.options.find((o) => o.name === 'Scent').values);
  for (const v of Object.values(scope.scope)) {
    assert.ok(values.has(v), `scope value "${v}" is not a Scent option value`);
  }
});

test('the corrected spelling is what config and the frames now carry', () => {
  // The defect this replaced: Shopify's Scent value read "Frankincence".
  const blob = JSON.stringify(b);
  assert.ok(!blob.includes('Frankincence'), 'config/bundles.json still carries the old misspelling');
  assert.ok(blob.includes('Wildcrafted Frankincense'), 'the frankincense variant went missing');
  assert.ok(!packFrame('4x Wildcrafted Frankincense').alt().includes('Frankincence'),
    'the rendered alt text still carries the old misspelling');
});

test('the aluminium-free claim is true of the deodorant', () => {
  const all = [...ing.deodorant.base_ingredients,
    ...(ing.deodorant.variations ?? []).flatMap((v) => v.essential_oils ?? [])].join(' ').toLowerCase();
  for (const t of ['aluminium', 'aluminum']) {
    assert.ok(!all.includes(t), `the SEO title claims aluminium-free but "${t}" is in the formulation`);
  }
});

console.log('✓ deodorant-4-pack tests pass');
