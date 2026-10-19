// Cream PDP: ads link to ?variant=<Coconut Breeze>; the ladder must open on
// 1 jar in that scent. Source scan of the template's quantity-ladder block plus
// a run of its scent-mapping function against a stub.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = join(ROOT, 'theme/templates/product.landing-page-cream.json');
const raw = readFileSync(FILE, 'utf8');
const liquid = JSON.parse(raw).sections.main.blocks['quantity-ladder'].settings.custom_liquid;

function load() {
  const start = liquid.indexOf('function scentFromVariantParam');
  assert.ok(start > -1, 'scentFromVariantParam missing');
  const end = liquid.indexOf('\n  }\n', start) + 4;
  const src = liquid.slice(start, end);
  const ladderOptionLabel = (t) => (/^Variety\s*[—-]\s*.+/i.test(t) ? 'Variety' : t.replace(/^\d+x\s+/i, ''));
  const data = {
    'coconut-moisturizer': { variants: [
      { id: 44179428475050, title: 'Coconut Breeze', available: true },
      { id: 45828182114474, title: 'Pure Unscented', available: true },
      { id: 1, title: 'Sold Out Scent', available: false },
    ] },
    'coconut-moisturizer-4-pack': { variants: [{ id: 99, title: '4x Coconut Breeze', available: true }] },
  };
  return new Function('data', 'ladderOptionLabel', `${src}; return scentFromVariantParam;`)(data, ladderOptionLabel);
}

test('ladder opens on the 1-jar tier', () => {
  assert.match(liquid, /assign ladder_default = "coconut-moisturizer" -%}/);
});

test('script reads ?variant= via URLSearchParams', () => {
  assert.match(liquid, /new URLSearchParams\(search\)\.get\('variant'\)/);
  assert.match(liquid, /chosenOption = scentFromVariantParam\(window\.location\.search\)/);
});

test('maps a known variant id to its scent', () => {
  const f = load();
  assert.equal(f('?variant=44179428475050'), 'Coconut Breeze');
  assert.equal(f('?utm=x&variant=45828182114474'), 'Pure Unscented');
  assert.equal(f('?variant=99'), 'Coconut Breeze');
});

test('unknown, missing, or sold-out variant leaves the default', () => {
  const f = load();
  assert.equal(f('?variant=12345'), null);
  assert.equal(f(''), null);
  assert.equal(f('?variant=abc'), null);
  assert.equal(f('?variant=1'), null);
});

test('template keeps \\/ escaping', () => {
  assert.ok(raw.includes('\\/'));
});
