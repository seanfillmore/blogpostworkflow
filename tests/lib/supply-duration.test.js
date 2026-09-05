// tests/lib/supply-duration.test.js
//
// Regression tests for a claim that reached the storefront: "60 DAYS of
// everything" on a box holding one of each of seven products, when the sibling
// bundle sells three of each for ninety. Every assertion below would have failed
// that frame before it rendered.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindingDuration, assertDurationClaim } from '../../lib/supply-duration.js';
import { SKU_BY_HANDLE } from '../../lib/bundle-roster.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
const componentsOf = (handle) => bundles.find((b) => b.handle === handle).variants[0].components;
const { rates: RATES } = JSON.parse(readFileSync(join(ROOT, 'config', 'consumption-rates.json'), 'utf8'));

test('a box is limited by the FIRST thing to run out, not the average or the longest', () => {
  const r = bindingDuration(componentsOf('head-to-toe'));
  assert.equal(r.limitedBy, 'coconut-soap', 'the bar soap is the binding component');
  assert.equal(r.days, 25);
  // The toothpaste in the same box is ~61 days. An average (or the headline
  // product) would have licensed exactly the overstatement this guards against.
  // Assert the invariant this test is NAMED for — the binding duration is below
  // both the average and the longest — rather than a fixed ratio against one
  // component. The old form asserted `days < toothpaste/2`, which was true only
  // while toothpaste sat at its gap-derived 61 d/unit; the merchant corrected it
  // to 45 on 2026-08-30 and the assertion broke without the guarded behaviour
  // changing at all. A test calibrated to a data value fails when the data is
  // corrected, which is the opposite of what a regression test is for.
  const days = r.detail.map((d) => d.days);
  const average = days.reduce((s, d) => s + d, 0) / days.length;
  assert.ok(r.days < average, `binding ${r.days}d must be under the ${average.toFixed(1)}d average — averaging overstates`);
  assert.ok(r.days < Math.max(...days), 'binding duration must be under the longest component, never equal to it');
});

test('a multipack is grouped by product before the minimum is taken', () => {
  // The Variety 4-pack is four rows of qty 1 of the SAME product. Row-wise this
  // returned 25 days — one bar — for a box that plainly holds four. Any cadence
  // set from that ships four times too often.
  const r = bindingDuration(componentsOf('coconut-bar-soap-4-pack'));
  assert.equal(r.detail.length, 1, 'four rows of one product must collapse to one entry');
  assert.equal(r.detail[0].qty, 4);
  assert.equal(r.days, 100, '4 bars x 25 days');
});

test('the 60-day Head-to-Toe claim that shipped is rejected', () => {
  assert.throws(
    () => assertDurationClaim(60, componentsOf('head-to-toe'), 'Head-to-Toe'),
    /claims 60 days.*after ~25.*coconut-soap runs out first/s,
  );
});

test('one of each is a month, because three of each is a quarter', () => {
  // The arithmetic Sean used to catch it, asserted directly: the 90-Day Clean
  // Swap and The Clean Swap are the same four products at 3x and 1x.
  const ninety = bindingDuration(componentsOf('90-day-clean-swap'));
  const one = bindingDuration(componentsOf('clean-swap'));
  assert.equal(ninety.days, one.days * 3, 'tripling the quantity triples the duration');
  assert.ok(one.days < 60, `one of each is ${one.days} days — under two months, so a 60-day claim on a 1x box is never safe`);
});

test('the 90-Day Clean Swap no longer supports the 90 in its own name', () => {
  // It did, on the old gap-derived bar soap rate of 47 d/unit. Sean corrected
  // that on 2026-08-02 — "a bar of soap is lasting between 20 and 30 days in the
  // shower" — and at 25 the box holds three bars, or 75 days. The name, the
  // bundle.duration_days metafield and the lander's "Everything in your 90-day
  // box" all claim 90.
  //
  // This test asserts the CONFLICT rather than resolving it. Closing it is a
  // merchandising decision: add a fourth bar (100 days, covers 90), rename, or
  // accept that the soap is the one item needing a mid-cycle top-up.
  const r = bindingDuration(componentsOf('90-day-clean-swap'));
  assert.equal(r.limitedBy, 'coconut-soap');
  assert.equal(r.days, 75);
  assert.throws(() => assertDurationClaim(90, componentsOf('90-day-clean-swap'), '90-Day Clean Swap'),
    /claims 90 days.*after ~75/s, 'the guard must refuse the 90 while the box holds 75');
});

test('the guard still accepts a claim the contents do support', () => {
  // A guard that fails everything gets deleted the first time it is inconvenient.
  const r = assertDurationClaim(75, componentsOf('90-day-clean-swap'), '90-Day Clean Swap');
  assert.equal(r.days, 75);
  assert.doesNotThrow(() => assertDurationClaim(150, componentsOf('coconut-deodorant-4-pack'), 'Deodorant 4-Pack'));
});

// These two used `organic-foaming-hand-soap` and `coconut-oil-lip-balm` as stand-ins
// for "a product with no measured rate". On 2026-09-05 both were given merchant
// estimates, which made every real component product rated and broke both tests —
// the fixtures went stale, the behaviour did not. They now use a handle that is not
// in the catalogue at all, so rating a real SKU can never break them again.
const UNRATED = 'not-a-real-product-handle';

test('a claim with no evidence behind it fails rather than passing quietly', () => {
  assert.throws(
    () => assertDurationClaim(30, [{ product: UNRATED, qty: 1 }], 'hypothetical'),
    /no component has a measured consumption rate/,
  );
});

test('components with no measured rate are reported, not silently ignored', () => {
  const r = bindingDuration([
    { product: 'coconut-lotion', qty: 1 },
    { product: UNRATED, qty: 1 },
  ]);
  assert.deepEqual(r.unknown, [UNRATED]);
  // Silence here would be the dangerous answer: the true binding component could
  // be the unrated one and the returned figure would be too generous.
  assert.ok(r.unknown.length > 0);
  assert.equal(r.days, 30, 'the rated component still yields a figure, flagged as partial');
});

test('every product in SKU_BY_HANDLE has a consumption rate', () => {
  // The condition that broke the two tests above, asserted directly: as of
  // 2026-09-05 every component product is rated. If a NEW product is added to the
  // roster without a rate, any duration claim involving it is unevidenced — which
  // is exactly how lip balm and liquid soap carried unsupported claims for months.
  const missing = Object.keys(SKU_BY_HANDLE).filter((h) => !RATES[h]);
  assert.deepEqual(missing, [], `no consumption rate for: ${missing.join(', ')}`);
});

test('a malformed claim is rejected before any rate lookup', () => {
  for (const bad of [0, -30, 1.5, NaN, '30']) {
    assert.throws(() => assertDurationClaim(bad, componentsOf('head-to-toe')), /not a positive whole number/);
  }
});

console.log('✓ supply-duration tests pass');
