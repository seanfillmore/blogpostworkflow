// tests/config/gift-box-claims.test.js
//
// The Gift Box has two claims that are false for it and true-sounding enough to
// get written by accident. Both have a specific reason, both are enforced in
// gb-common.mjs, and both are asserted here so the guard cannot be quietly
// removed along with the frame that motivated it.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const { bundles } = read('config/bundles.json');
const ing = read('config/ingredients.json');
const giftBox = bundles.find((b) => b.handle === 'gift-box');

test('the Gift Box is not unscented, and the reason is in the data', () => {
  // The site FAQ says we do not make an unscented deodorant. If a kit ships a
  // scented deodorant, the BOX is scented however unscented the rest of it is.
  const scentedDeoKits = giftBox.variants.filter((v) =>
    v.components.some((c) => c.product === 'coconut-oil-deodorant' && !/unscented/i.test(c.variant)));
  assert.ok(scentedDeoKits.length > 0,
    'no kit ships a scented deodorant any more — re-check whether the "unscented" ban still applies before relaxing it');
  // And confirm the config agrees no unscented deodorant exists to switch to.
  const deoVariants = (ing.deodorant.variations ?? []).map((v) => v.name);
  assert.ok(!deoVariants.some((n) => /unscented/i.test(n)),
    `config/ingredients.json now lists an unscented deodorant (${deoVariants.join(', ')}) — the ban may be revisitable`);
});

test('"vegan" and "no palm oil" are false for every Gift Box kit', () => {
  // The lip balm is in all three kits and carries both.
  const balm = ing.lip_balm.base_ingredients.map((i) => i.toLowerCase());
  assert.ok(balm.some((i) => i.includes('beeswax')), 'lip balm no longer lists beeswax — the vegan ban may be revisitable');
  assert.ok(balm.some((i) => i.includes('palm')), 'lip balm no longer lists palm — the no-palm ban may be revisitable');
  for (const v of giftBox.variants) {
    assert.ok(v.components.some((c) => c.product === 'coconut-oil-lip-balm'),
      `the ${Object.values(v.options)[0]} kit no longer contains the lip balm — re-check both bans`);
  }
});

test('the absences the ingredient frame claims are genuinely absent', () => {
  const CLAIMED_ABSENT = ['sodium lauryl sulfate', 'sodium laureth sulfate', 'paraben', 'phthalate', 'aluminium', 'aluminum'];
  const all = [];
  for (const k of ['lotion', 'bar_soap', 'deodorant', 'lip_balm']) {
    all.push(...ing[k].base_ingredients);
    for (const v of ing[k].variations ?? []) all.push(...(v.essential_oils ?? []));
  }
  const hay = all.join(' | ').toLowerCase();
  for (const term of CLAIMED_ABSENT) {
    assert.ok(!hay.includes(term.toLowerCase()),
      `the Gift Box ingredient frame claims no "${term}", but it appears in one of the four components`);
  }
  // The frame prints a count, so the union must stay a plausible size.
  const union = new Set(['lotion', 'bar_soap', 'deodorant', 'lip_balm'].flatMap((k) => ing[k].base_ingredients));
  assert.ok(union.size >= 4 && union.size <= 20, `ingredient union is ${union.size} — implausible for a printed count`);
});

test('one purchased lip balm is still four tubes, per the SKU title', () => {
  // Frame 1 draws four tubes, and gb-common.mjs derives that count by parsing
  // the product title. config/ingredients.json does NOT record pack size — the
  // first version of this test looked there and failed for that reason.
  const { products } = read('data/brand/product-catalog.json');
  const title = products['coconut-oil-lip-balm']?.title ?? '';
  assert.match(title, /(four|4)[\s-]?pack/i,
    `the lip balm SKU title is now "${title}" — it no longer says four-pack, so drawing four tubes overstates the box`);
  // And the other three must stay single units, or frame 1 under-draws them.
  for (const h of ['coconut-lotion', 'coconut-oil-deodorant', 'coconut-soap']) {
    assert.doesNotMatch(products[h]?.title ?? '', /\d[\s-]?pack|\b(two|three|four|five|six)[\s-]?pack\b/i,
      `${h} is now sold as a multi-pack — frame 1 draws it as a single unit`);
  }
});

console.log('✓ gift-box claim tests pass');

test('the packaging frames have a box to draw', () => {
  // Frames 6 and 7 have no subject at all without these. They were built from a
  // supplier 3D visualization, not a photograph — README.md in that directory
  // records the distinction and the basis for using them.
  const { existsSync } = require('node:fs');
  for (const f of ['mailer-10x8x4-open.png', 'mailer-10x8x4-closed.png', 'mailer-10x8x4-3d-source.pdf', 'README.md']) {
    assert.ok(existsSync(join(ROOT, 'data', 'brand', 'packaging', f)), `data/brand/packaging/${f} is missing`);
  }
  // The README is what stops the next person compositing products into an empty
  // render and calling it a photograph. Its absence is a real regression.
  const readme = readFileSync(join(ROOT, 'data', 'brand', 'packaging', 'README.md'), 'utf8');
  assert.match(readme, /renderings, not photographs/i, 'the packaging README no longer states these are renderings');
  assert.match(readme, /Do not composite products into the open box/i, 'the packaging README lost its compositing warning');
});
