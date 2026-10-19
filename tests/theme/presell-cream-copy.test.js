// tests/theme/presell-cream-copy.test.js
//
// Pins the copy of the Coconut Moisturizer pre-sell page
// (data/presell/coconut-cream/content.json), which is a COMMERCIAL surface: it
// ends in a buy box. Every string on it, and the transcript of every creator
// video it plays, must clear the health-claim gate on the default commercial
// surface, carry no em dash, never name the comparison brand, never name a
// petroleum ingredient or call the product an antiperspirant, and state the
// ingredient base exactly as config/ingredients.json does.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'data', 'presell', 'coconut-cream');
const CONTENT = join(DIR, 'content.json');
const MEDIA = join(DIR, 'media.json');

// Marvin Aboagye's video says the cream has "6 ingredients" (the lotion's
// count). It must never be chosen.
const MARVIN_SUBMISSION = 'submission_9e54abc8-a621-48d9-a5f4-4f129dc1412d';

// Provenance fields: recorded so the comparison can be re-checked, never
// rendered on the page. They are exempt from the brand-name check only (the
// retailer URL carries the brand in its path); Task 2 must not render them.
const PROVENANCE_PATHS = new Set(['theirLabel.sourceUrl', 'theirLabel.manufacturerUrl']);

function load() {
  assert.ok(existsSync(CONTENT), `missing ${CONTENT}`);
  return JSON.parse(readFileSync(CONTENT, 'utf8'));
}

/** Every string in the object, with its dotted path. */
function strings(value, path = '', out = []) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

test('content.json has the shape later tasks render', () => {
  const c = load();
  for (const k of ['headline', 'eyebrow', 'intro', 'guarantee']) assert.equal(typeof c[k], 'string', k);
  assert.equal(c.reasons.length, 5);
  c.reasons.forEach((r, i) => {
    assert.equal(r.n, i + 1);
    assert.ok(r.title && r.body, `reason ${i + 1} copy`);
    assert.ok(['image', 'video'].includes(r.media.kind), `reason ${i + 1} media kind`);
    assert.ok(r.media.key, `reason ${i + 1} media key`);
  });
  assert.ok(c.reviews.length >= 2);
  for (const r of c.reviews) assert.ok(r.quote && /^\S+ [A-Z]\.$/.test(r.name), `review name ${r.name}`);
  for (const k of ['title', 'priceNote', 'shipping']) assert.equal(typeof c.buyBox[k], 'string', k);
});

test('headline states the 7-ingredient base', () => {
  assert.match(load().headline, /7-ingredient base/);
});

test('ourLabel is exactly the cream base from config/ingredients.json', () => {
  const ing = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
  assert.deepEqual(load().ourLabel, ing.cream.base_ingredients);
});

test('the comparison label is real and its count is stated truthfully', () => {
  const c = load();
  const n = c.theirLabel.ingredients.length;
  assert.ok(n >= 20, `comparison label has ${n} ingredients`);
  assert.match(c.theirLabel.sourceUrl, /^https:\/\//);
  assert.match(c.theirLabel.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  // Any count the copy quotes for "a popular drugstore coconut lotion" must be its real length.
  const copy = strings(c).filter(([p]) => !p.startsWith('theirLabel')).map(([, s]) => s).join(' ');
  for (const m of copy.matchAll(/lists (\d+) ingredients/g)) assert.equal(Number(m[1]), n);
});

test('every string and every chosen transcript clears the commercial health gate', () => {
  const c = load();
  const fields = Object.fromEntries(strings(c));
  const res = checkSeoCopyFields(fields);
  assert.equal(res.ok, true, JSON.stringify(res.blocking, null, 1));
  // Transcripts are in content.videos[*].transcript, already covered above;
  // assert they are present so the coverage cannot silently vanish.
  for (const [key, v] of Object.entries(c.videos)) {
    assert.ok(v.transcript && v.transcript.length > 40, `transcript for ${key}`);
    assert.equal(checkSeoCopyFields({ transcript: v.transcript }).ok, true, key);
  }
});

test('no em dash, no comparison brand, no petroleum names, never antiperspirant', () => {
  for (const [p, s] of strings(load())) {
    assert.ok(!s.includes('—'), `em dash at ${p}`);
    if (!PROVENANCE_PATHS.has(p)) assert.ok(!/palmer/i.test(s), `brand name at ${p}`);
    assert.ok(!/mineral oil|petrolatum|paraffin|antiperspirant/i.test(s), `forbidden term at ${p}: ${s}`);
  }
});

test('every reason media key is defined, and Marvin Aboagye is never used', () => {
  const c = load();
  const keys = new Set([...Object.keys(c.videos), ...Object.keys(c.images)]);
  for (const r of c.reasons) {
    assert.ok(keys.has(r.media.key), `undefined media key ${r.media.key}`);
    assert.equal(r.media.kind === 'video', r.media.key in c.videos, `${r.media.key} kind`);
  }
  assert.ok(!JSON.stringify(c).includes(MARVIN_SUBMISSION), 'content references Marvin Aboagye');
  if (existsSync(MEDIA)) assert.ok(!readFileSync(MEDIA, 'utf8').includes('9e54abc8'), 'media references Marvin Aboagye');
  // The first screen keeps a still.
  assert.equal(c.hero.kind, 'image');
});

test('media.json, once written, covers every media key with a CDN url', () => {
  if (!existsSync(MEDIA)) return;
  const c = load();
  const m = JSON.parse(readFileSync(MEDIA, 'utf8'));
  const used = [c.hero.key, ...c.reasons.map(r => r.media.key)];
  for (const k of used) {
    assert.ok(m[k], `media.json missing ${k}`);
    assert.match(m[k].url, /^https:\/\/cdn\.shopify\.com\//, `${k} url`);
    if (m[k].kind === 'video') assert.match(m[k].poster || '', /^https:\/\/cdn\.shopify\.com\//, `${k} poster`);
  }
});
