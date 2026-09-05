import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCTS, GAMMA, modelHeights, targetFractions, kindOf, parseArgs, validate,
} from '../../scripts/scale-bundle-component-images.mjs';

// A FIXTURE, not an import — see the note in scale-theme-component-image.test.js.
const LIVE_THEME_ID = '148439367850';

// The fractions are DERIVED (volume + tight-crop aspect), not chosen. These tests
// pin the derivation against reality, so a change to the model has to keep
// producing product sizes somebody can check against a physical shelf.

test('the model reproduces real product heights', () => {
  const h = modelHeights();
  const inches = (k) => (h[k] / h.lotion) * 6.5;   // anchored: 8oz lotion bottle = 6.5in
  // Each of these is checkable by picking the product up.
  assert.ok(Math.abs(inches('cream') - 2.1) < 0.4, `4oz cream jar ~2in, got ${inches('cream').toFixed(2)}`);
  assert.ok(Math.abs(inches('toothpaste') - 5.4) < 0.6, `4oz toothpaste tube ~5.4in, got ${inches('toothpaste').toFixed(2)}`);
  assert.ok(Math.abs(inches('deodorant') - 3.7) < 0.6, `2oz deodorant ~3.7in, got ${inches('deodorant').toFixed(2)}`);
  assert.ok(inches('handsoap') > inches('lotion'), 'an 8oz foaming pump is taller than an 8oz lotion bottle');
});

test('the operator-approved cream/lotion ratio survives global normalisation', () => {
  // This is the whole reason global scale is safe. The Coconut Reset shipped the
  // cream at 0.405 of a full-height lotion and the operator approved it by eye.
  // Rescaling everything to the tallest product in the CATALOGUE shrinks both,
  // but the relationship between them must come out unchanged.
  const f = targetFractions();
  assert.ok(Math.abs(f.cream / f.lotion - 0.405) < 0.002,
    `cream/lotion must stay 0.405, got ${(f.cream / f.lotion).toFixed(4)}`);
});

test('compression lifts small products without ever reordering them', () => {
  const h = modelHeights();
  const trueScale = targetFractions(h, 1);
  const shown = targetFractions(h, GAMMA);
  const order = (o) => Object.keys(o).sort((a, b) => o[b] - o[a]).join(',');
  assert.equal(order(shown), order(trueScale), 'gamma < 1 must not change the ordering');
  for (const k of Object.keys(shown)) {
    assert.ok(shown[k] >= trueScale[k] - 1e-9, `${k}: compression may only lift, never shrink`);
  }
  assert.ok(shown.soap > trueScale.soap, 'the smallest item is the one that needed lifting');
});

test('every product tops out at exactly one 1.0 — the tallest', () => {
  const f = targetFractions();
  const ones = Object.entries(f).filter(([, v]) => v >= 0.999).map(([k]) => k);
  assert.deepEqual(ones, ['handsoap'], 'exactly one asset stays a full-height tight crop');
});

test('kindOf reads the kind out of the asset key', () => {
  assert.equal(kindOf('assets/component-soap-nourishing-tea-tree.webp'), 'soap');
  assert.equal(kindOf('assets/component-lipbalm-vanilla-dream.webp'), 'lipbalm');
  assert.equal(kindOf('assets/logo.png'), null);
});

test('every kind in PRODUCTS gets a fraction, and lipbalm is added on top', () => {
  const f = targetFractions();
  for (const k of Object.keys(PRODUCTS)) assert.ok(f[k] > 0, `${k} has no fraction`);
  assert.ok(f.lipbalm > 0, 'the 4-pack asset is anchored separately and must still be covered');
});

test('the live theme is refused with NO override', () => {
  const r = validate({ theme: LIVE_THEME_ID }, LIVE_THEME_ID);
  assert.equal(r.ok, false);
  assert.match(r.reason, /LIVE/);
  // And an unresolvable live id refuses too — this rewrites 15 assets at once,
  // so "we could not check" must never resolve to "go ahead".
  assert.equal(validate({ theme: '145536778410' }, null).ok, false);
  // Unlike the single-image scaler there is deliberately no --allow-live-theme:
  // this rewrites 15 assets in one pass and must be eyeballed on a preview.
  assert.throws(() => parseArgs(['--allow-live-theme']), /unknown argument/);
});

test('a target theme is never guessed', () => {
  assert.equal(validate({}, LIVE_THEME_ID).ok, false);
  assert.equal(validate({ theme: '999' }, LIVE_THEME_ID).ok, true);
});
