// The committed config/press-facts.json: every product the pitch writer may
// name, its ingredients kept in step with config/ingredients.json, and every
// fact Sean adds checked by the same gate the drafting run applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTS } from '../../lib/press-contacts.js';
import { PRODUCT_CONFIG_KEYS, checkFact, buildFactSheet } from '../../lib/press-pitch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const FACTS = read('config/press-facts.json');
const INGREDIENTS = read('config/ingredients.json');

test('every PRODUCTS key has an entry with the fields the fact sheet renders', () => {
  assert.deepEqual(Object.keys(FACTS.products).sort(), [...PRODUCTS].sort());
  for (const k of PRODUCTS) {
    const p = FACTS.products[k];
    for (const f of ['name', 'format', 'price', 'url']) assert.ok(typeof p[f] === 'string' && p[f], `${k}.${f}`);
    assert.ok(Array.isArray(p.base_ingredients) && p.base_ingredients.length, `${k}.base_ingredients`);
    assert.ok(Array.isArray(p.scents), `${k}.scents`);
    assert.ok(Array.isArray(p.facts), `${k}.facts`);
    assert.match(p.url, /^https:\/\/www\.realskincare\.com\/products\//, `${k}.url`);
  }
  assert.equal(FACTS.brand.website, 'https://www.realskincare.com');
});

test('drift guard: base_ingredients match config/ingredients.json for the mapped key', () => {
  for (const k of PRODUCTS) {
    const cfg = INGREDIENTS[PRODUCT_CONFIG_KEYS[k]];
    assert.ok(cfg, `config/ingredients.json has ${PRODUCT_CONFIG_KEYS[k]}`);
    assert.deepEqual(FACTS.products[k].base_ingredients, cfg.base_ingredients,
      `${k}: update config/press-facts.json and config/ingredients.json together`);
  }
});

test('every amazon_url is a plain amazon.com /dp/ ASIN link', () => {
  for (const k of PRODUCTS) {
    const u = FACTS.products[k].amazon_url;
    if (u === undefined) continue;
    assert.match(u, /^https:\/\/www\.amazon\.com\/dp\/B0[0-9A-Z]{8}$/, k);
  }
});

test('every committed fact passes the health / product-category gate', () => {
  const all = [
    ...FACTS.brand.facts.map((f) => ['brand.facts', f]),
    ...PRODUCTS.flatMap((k) => FACTS.products[k].facts.map((f) => [`products.${k}.facts`, f])),
  ];
  for (const [where, f] of all) {
    const c = checkFact(f);
    assert.ok(c.ok, `${where}: "${f}" ${c.reason}`);
    assert.doesNotMatch(f, /[—–]/, `${where}: no em or en dash`);
  }
  assert.deepEqual(buildFactSheet(FACTS).skippedFacts, []);
});
