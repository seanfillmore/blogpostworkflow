// tests/theme/presell-water-cooler.test.js
//
// Pins the water cooler pre-sell page (data/presell/water-cooler/content.json),
// the landing page for the Baby Drama water cooler ad. It is a COMMERCIAL
// surface (it ends in a buy box), so it carries the same gates as the cream
// page: every string clears the health-claim gate on the default commercial
// surface, no em dash, the comparison brand is never named, no petroleum names,
// never "antiperspirant", and the ingredient base is exactly the config's.
// It also pins what makes it THIS page: it sells Pure Unscented (the jar in the
// ad), quotes the ad's own lines, and plays the ad's clips silent.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';
import { buildTemplate, serialize, PAGES } from '../../scripts/presell/build-cream-template.mjs';
import { TARGETS } from '../../scripts/presell/publish-cream-presell.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'data', 'presell', 'water-cooler');
const PROVENANCE_PATHS = new Set(['theirLabel.sourceUrl', 'theirLabel.manufacturerUrl']);
const load = () => JSON.parse(readFileSync(join(DIR, 'content.json'), 'utf8'));
const loadMedia = () => JSON.parse(readFileSync(join(DIR, 'media.json'), 'utf8'));

function strings(value, path = '', out = []) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

test('sells Pure Unscented, the jar in the ad', () => {
  const c = load();
  assert.equal(c.product.defaultScent, 'Pure Unscented');
  assert.equal(c.product.defaultVariantId, '45828182114474');
  assert.ok(c.buyBox.cta.includes('Pure Unscented'));
  // A scent review would contradict an unscented page.
  for (const r of c.reviews) assert.ok(!/smell|scent/i.test(r.quote), `scent review: ${r.name}`);
});

test('carries the ad: its question in the headline and its lines as reasons', () => {
  const c = load();
  assert.match(c.headline, /What are you doing differently\?/);
  assert.match(c.headline, /7-ingredient/);
  assert.equal(c.reasons[0].title, 'Coconut cream. Seven ingredients. Every night.');
  assert.equal(c.videos['video-compliment'].caption, 'Carol. Your skin looks amazing.');
});

test('ourLabel is exactly the cream base, and Pure Unscented is described as that base alone', () => {
  const ing = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
  const c = load();
  assert.deepEqual(c.ourLabel, ing.cream.base_ingredients);
  const unscented = ing.cream.variations.find((v) => v.id === 'pure-unscented');
  assert.deepEqual(unscented.essential_oils, []);
  const copy = strings(c).filter(([p]) => !p.startsWith('theirLabel')).map(([, s]) => s).join(' ');
  for (const m of copy.matchAll(/lists (\d+) ingredients/g)) assert.equal(Number(m[1]), c.theirLabel.ingredients.length);
});

test('every string and transcript clears the commercial health gate', () => {
  const c = load();
  const res = checkSeoCopyFields(Object.fromEntries(strings(c)));
  assert.equal(res.ok, true, JSON.stringify(res.blocking, null, 1));
  for (const [key, v] of Object.entries(c.videos)) {
    assert.ok(v.transcript && v.transcript.length > 30, `transcript for ${key}`);
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

test('the ad clips are committed, silent and small enough for the page', () => {
  const c = load();
  for (const [key, v] of Object.entries(c.videos)) {
    if (v.source !== 'local') continue;
    const file = join(ROOT, v.path);
    assert.ok(existsSync(file), `${key} source missing`);
    assert.ok(statSync(file).size <= 1.5 * 1024 * 1024, `${key} over 1.5 MB`);
    const audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
    assert.equal(audio, '', `${key} has an audio track`);
    assert.equal(v.burnedInCaptions, true, `${key} captions are burned in from the ad`);
  }
  assert.equal(c.hero.kind, 'image');
});

test('media.json covers every media key with a CDN url', () => {
  const c = load();
  const m = loadMedia();
  for (const k of [c.hero.key, c.buyBox.image.key, ...c.reasons.map((r) => r.media.key)]) {
    assert.ok(m[k], `media.json missing ${k}`);
    assert.match(m[k].url, /^https:\/\/cdn\.shopify\.com\//, `${k} url`);
    if (m[k].kind === 'video') assert.match(m[k].poster || '', /^https:\/\/cdn\.shopify\.com\//, `${k} poster`);
  }
});

test('the committed template is exactly what the build produces', () => {
  const page = PAGES['water-cooler'];
  const built = serialize(buildTemplate(load(), loadMedia()));
  assert.equal(readFileSync(join(ROOT, page.template), 'utf8'), built);
});

test('publish target ships only the new template plus the unchanged shared files', () => {
  const t = TARGETS['water-cooler'];
  assert.equal(t.page.template_suffix, 'presell-water-cooler');
  assert.notEqual(t.page.handle, TARGETS['coconut-cream'].page.handle);
  const keys = t.files.map((f) => f.key);
  assert.ok(keys.includes('templates/page.presell-water-cooler.json'));
  assert.ok(!keys.includes('templates/page.presell-cream.json'), 'must never rewrite the cream template');
  assert.equal(t.files.find((f) => f.key === 'templates/page.presell-water-cooler.json').before, null);
});
