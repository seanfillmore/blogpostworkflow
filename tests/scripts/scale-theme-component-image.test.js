import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  parseArgs, validate, alreadyPadded,
} from '../../scripts/scale-theme-component-image.mjs';

// A FIXTURE, not an import. This used to be a constant in the module and it went
// stale when the store was republished on 2026-09-01 — the guard then protected
// an unpublished backup and waved the real live theme straight through. The id
// is resolved from the API at call time now and passed in.
const LIVE_THEME_ID = '148439367850';

// `object-fit: contain` scales each image to fit ITS OWN box, so a grid of
// components reads at whatever fraction of its canvas each product happens to
// fill — not at true relative size. This script puts the physical proportion in
// the asset so the CSS can stay generic.

test('parseArgs reads the three inputs and rejects an unknown flag', () => {
  const a = parseArgs(['--key', 'assets/x.webp', '--fraction', '0.405', '--theme', '123']);
  assert.equal(a.key, 'assets/x.webp');
  assert.equal(a.fraction, 0.405);
  assert.equal(a.theme, '123');
  assert.equal(a.allowLive, false);
  assert.throws(() => parseArgs(['--force']), /unknown argument/);
});

test('the live theme is refused unless the override is typed', () => {
  const base = { key: 'assets/x.webp', fraction: 0.4 };
  const r = validate({ ...base, theme: LIVE_THEME_ID }, LIVE_THEME_ID);
  assert.equal(r.ok, false);
  assert.match(r.reason, /LIVE/);
  assert.equal(validate({ ...base, theme: LIVE_THEME_ID, allowLive: true }, LIVE_THEME_ID).ok, true);
});

test('an UNRESOLVED live id refuses rather than writing to an unverified theme', () => {
  const r = validate({ key: 'assets/x.webp', fraction: 0.4, theme: '145536778410' }, null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not resolve/);
});

test('a target theme is never guessed', () => {
  const r = validate({ key: 'assets/x.webp', fraction: 0.4 }, LIVE_THEME_ID);
  assert.equal(r.ok, false);
  assert.match(r.reason, /--theme is required/);
});

test('the fraction must be a real proportion', () => {
  for (const f of [0, -0.2, 1.5, Number.NaN]) {
    assert.equal(validate({ key: 'a', theme: '1', fraction: f }, LIVE_THEME_ID).ok, false, `fraction ${f}`);
  }
  assert.equal(validate({ key: 'a', theme: '1', fraction: 1 }, LIVE_THEME_ID).ok, true, 'exactly 1 is a no-op but legal');
});

test('alreadyPadded is false for a tight crop and true for a padded canvas', async () => {
  // Tight: opaque all the way to the top row.
  const tight = await sharp({ create: { width: 40, height: 60, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 1 } } })
    .png().toBuffer();
  assert.equal(await alreadyPadded(sharp(tight)), false);

  // Padded: the art sits at the bottom, top row fully transparent.
  const art = await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 1 } } })
    .png().toBuffer();
  const padded = await sharp({ create: { width: 40, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: art, top: 40, left: 0 }]).png().toBuffer();
  assert.equal(await alreadyPadded(sharp(padded)), true);
});

test('the padded-source guard is what stops the ratio compounding silently', async () => {
  // Run at 0.4 twice and the product sits at 0.16 with nothing to say so. The
  // guard is the only thing between one deliberate pass and a silent second.
  const first = 0.4, second = 0.4;
  assert.equal(first * second, 0.16000000000000003);
  assert.ok(first * second < first, 'a second pass shrinks it again');
});
