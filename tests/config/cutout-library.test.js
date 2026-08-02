// tests/config/cutout-library.test.js
//
// The cutout library is the input to every composited bundle frame, and the way
// it breaks is silent: a kit gains a scent, nobody cuts the new variant, and the
// next render either throws deep inside a frame module or — worse — a frame that
// does not happen to draw that component ships fine while the one that does is
// the last thing anyone tries.
//
// These assertions make the coupling explicit: config/bundles.json says what
// ships, data/brand/cutouts holds the photography, and a component named in the
// former with no PNG in the latter is a build failure here rather than a
// surprise at render time.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const recipes = read('data/brand/cutouts/recipes.json');
const { bundles } = read('config/bundles.json');

/** Same PNG-header read h2t-common.mjs uses, so the test agrees with the renderer. */
function pngSize(rel) {
  const fd = openSync(join(ROOT, rel), 'r');
  const buf = Buffer.alloc(24);
  readSync(fd, buf, 0, 24, 0);
  closeSync(fd);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${rel} is not a PNG`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test('every cutout recipe points at a source photo that exists', () => {
  for (const c of recipes.cutouts) {
    assert.ok(existsSync(join(ROOT, c.source)), `${c.out}: source photo missing — ${c.source}`);
  }
});

test('every cutout recipe has produced a non-degenerate PNG', () => {
  for (const c of recipes.cutouts) {
    const rel = `data/brand/cutouts/${c.out}`;
    assert.ok(existsSync(join(ROOT, rel)), `${c.out} is in the manifest but not on disk — run scripts/rebuild-cutouts.mjs`);
    const { w, h } = pngSize(rel);
    // A key that ate the product still writes a file. A 20px sliver is the shape
    // that failure takes, and it is invisible until the frame is composited.
    assert.ok(w > 100 && h > 100, `${c.out} is ${w}x${h} — the key almost certainly ate the product`);
  }
});

test('every recipe states a seed, and white-on-white products keep fuzz low', () => {
  for (const c of recipes.cutouts) {
    assert.match(c.seed ?? '', /^\d+,\d+$/, `${c.out}: --seed must be "X,Y"`);
    assert.ok(c.fuzz > 0 && c.fuzz <= 5, `${c.out}: fuzz ${c.fuzz} is outside the range these photos tolerate`);
    // The foaming hand soap is white product, white foam, white backdrop: at 1.5%
    // the flood crosses the foam into the bottle and punches a hole through the
    // body that no thumbnail shows.
    if (c.out.includes('handsoap-pure-unscented')) {
      assert.ok(c.fuzz <= 1, `${c.out}: fuzz must stay at or below 1% — at 1.5% the flood eats the bottle body`);
    }
  }
});

test('every component of every live bundle variant has a cutout', () => {
  // Only bundles whose frames are built from cutouts. A bundle with no gallery
  // yet is not a failure; a bundle whose gallery draws a component we cannot cut
  // is, and that is what this catches the day someone adds a scent to a kit.
  const KIND = {
    'coconut-lotion': 'lotion',
    'coconut-moisturizer': 'cream',
    'coconut-oil-deodorant': 'deodorant',
    'coconut-oil-toothpaste': 'toothpaste',
    'coconut-soap': 'soap',
    'coconut-oil-lip-balm': 'lipbalm',
    'organic-foaming-hand-soap': 'handsoap',
  };
  const WITH_COMPOSITED_GALLERIES = ['head-to-toe'];

  for (const handle of WITH_COMPOSITED_GALLERIES) {
    const b = bundles.find((x) => x.handle === handle);
    assert.ok(b, `config/bundles.json has no bundle "${handle}"`);
    for (const v of b.variants) {
      for (const c of v.components) {
        const kind = KIND[c.product];
        assert.ok(kind, `${handle}: no cutout naming for component product "${c.product}"`);
        const slug = `${kind}-${c.variant.toLowerCase().replace(/\s+/g, '-')}`;
        const rel = `data/brand/cutouts/component-${slug}.png`;
        assert.ok(existsSync(join(ROOT, rel)),
          `${handle} / ${Object.values(v.options)[0]} ships ${c.variant} ${c.product}, but ${rel} does not exist. `
          + `Add a recipe to data/brand/cutouts/recipes.json and run scripts/rebuild-cutouts.mjs.`);
      }
    }
  }
});

test('the Head-to-Toe value stack still reconciles with compare-at', () => {
  // Free shipping starts at $45 site-wide and this bundle is priced above it, so
  // shipping is not incremental value. Counting it was what made every bundle's
  // value stack disagree with its own compare-at price until 2026-08-02.
  const b = bundles.find((x) => x.handle === 'head-to-toe');
  const stack = [
    ['Body Lotion (8oz)', 30], ['Body Cream (4oz)', 28], ['Natural Deodorant', 15],
    ['Coconut Toothpaste', 13], ['Coconut Bar Soap', 11], ['Lip Balm', 15], ['Foaming Hand Soap', 13],
  ];
  const sum = stack.reduce((a, [, n]) => a + n, 0);
  for (const v of b.variants) {
    assert.equal(sum, v.compareAtPrice,
      `the value stack sums to $${sum} but compare-at is $${v.compareAtPrice} — they must agree before a frame prints a saving`);
    assert.ok(v.price / v.components.length < 15,
      `$${v.price} over ${v.components.length} products is $${(v.price / v.components.length).toFixed(2)} each, `
      + 'at or above the $15 ceiling frame 3 is built on');
  }
});

console.log('✓ cutout-library tests pass');
