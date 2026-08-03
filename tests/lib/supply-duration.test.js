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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
const componentsOf = (handle) => bundles.find((b) => b.handle === handle).variants[0].components;

test('a box is limited by the FIRST thing to run out, not the average or the longest', () => {
  const r = bindingDuration(componentsOf('head-to-toe'));
  assert.equal(r.limitedBy, 'coconut-soap', 'the bar soap is the binding component');
  assert.equal(r.days, 25);
  // The toothpaste in the same box is ~61 days. An average (or the headline
  // product) would have licensed exactly the overstatement this guards against.
  const tp = r.detail.find((d) => d.product === 'coconut-oil-toothpaste');
  assert.ok(r.days < tp.days / 2, 'the shortest component is a fraction of the longest — averaging is not safe here');
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

test('a claim with no evidence behind it fails rather than passing quietly', () => {
  assert.throws(
    () => assertDurationClaim(30, [{ product: 'organic-foaming-hand-soap', qty: 1 }], 'hypothetical'),
    /no component has a measured consumption rate/,
  );
});

test('components with no measured rate are reported, not silently ignored', () => {
  const r = bindingDuration(componentsOf('head-to-toe'));
  assert.deepEqual(r.unknown.sort(), ['coconut-oil-lip-balm', 'organic-foaming-hand-soap']);
  // Silence here would be the dangerous answer: the true binding component could
  // be one of these and the returned figure would be too generous.
  assert.ok(r.unknown.length > 0);
});

test('a malformed claim is rejected before any rate lookup', () => {
  for (const bad of [0, -30, 1.5, NaN, '30']) {
    assert.throws(() => assertDurationClaim(bad, componentsOf('head-to-toe')), /not a positive whole number/);
  }
});

console.log('✓ supply-duration tests pass');
