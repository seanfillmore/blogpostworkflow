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
  assert.equal(r.limitedBy, 'coconut-moisturizer', 'the body cream is the binding component');
  assert.equal(r.days, 28);
  // The deodorant in the same box is ~90 days. An average (or the headline
  // product) would have licensed exactly the overstatement this guards against.
  const deo = r.detail.find((d) => d.product === 'coconut-oil-deodorant');
  assert.equal(deo.days, 90);
  assert.ok(r.days < deo.days / 3, 'the shortest component is a small fraction of the longest — averaging is not safe here');
});

test('the 60-day Head-to-Toe claim that shipped is rejected', () => {
  assert.throws(
    () => assertDurationClaim(60, componentsOf('head-to-toe'), 'Head-to-Toe'),
    /claims 60 days.*after ~28.*coconut-moisturizer runs out first/s,
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

test("the 90-Day Clean Swap's own 90-day claim is still supportable", () => {
  // The guard must not be so strict it rejects true claims — a guard that fails
  // everything gets deleted the first time it is inconvenient.
  const r = assertDurationClaim(90, componentsOf('90-day-clean-swap'), '90-Day Clean Swap');
  assert.ok(r.days >= 90, `binding duration ${r.days} should support the stated 90`);
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
