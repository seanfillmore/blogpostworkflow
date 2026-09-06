import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST, templateNick } from '../../scripts/build-product-templates.mjs';
import {
  fileForSuffix, pageHandles, staleRedundantCards, subscribableDrift,
  orphanTemplates, summarize, renderReport,
} from '../../lib/pdp-template-drift.js';

const ROOT = join(import.meta.dirname, '..', '..');
const tpl = (f) => JSON.parse(readFileSync(join(ROOT, 'theme', 'templates', f), 'utf8'));
const allTemplates = () => Object.fromEntries(Object.keys(MANIFEST).map((f) => [f, tpl(f)]));
/** Every template keyed by FILE, holding whatever products templateSuffix names. */
const byFile = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [fileForSuffix(k), v]));

test('templateSuffix maps to the FILE, not the nickname', () => {
  // The gate's first live run reported all eight templates as orphans because
  // it keyed on `toothpaste` while Shopify says `landing-page-toothpaste`.
  assert.equal(fileForSuffix('landing-page-toothpaste'), 'product.landing-page-toothpaste.json');
  assert.equal(fileForSuffix('bundle-landing'), 'product.bundle-landing.json');
  assert.ok(MANIFEST[fileForSuffix('landing-page-toothpaste')], 'suffix must resolve into the manifest');
});

test('pageHandles unions the ladder TIERS, which templateSuffix cannot see', () => {
  // A tier is a separate product on the DEFAULT template. Without this the
  // three ladder pages read as "nothing subscribable" and the gate reported
  // three false alarms on its first live run.
  const f = 'product.landing-page-toothpaste.json';
  const handles = pageHandles(f, byFile({ 'landing-page-toothpaste': ['coconut-oil-toothpaste'] }), allTemplates());
  assert.ok(handles.includes('coconut-oil-toothpaste'), 'direct product');
  assert.ok(handles.includes('coconut-toothpaste-3-pack'), 'ladder tier');
});

test('a card its own ladder makes redundant is reported', () => {
  // The PR #805 shape: a ladder is added, an existing card becomes redundant,
  // and the manifest has not been told.
  const templates = allTemplates();
  const f = 'product.landing-page-lotion.json';
  // lotion's card points at the Sensitive Skin Set; give it a ladder that sells it.
  templates[f].sections.main.blocks['quantity-ladder'] = {
    type: 'custom_liquid',
    settings: { custom_liquid: '{%- assign ladder_handles = "coconut-lotion,sensitive-skin-starter-set" | split: "," -%}' },
  };
  const stale = staleRedundantCards(templates);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].template, 'lotion');
  assert.equal(stale[0].product, 'sensitive-skin-starter-set');
});

test('a card already in dropSections is NOT reported again', () => {
  // Those four are handled; re-reporting them would make the gate noisy forever.
  assert.deepEqual(staleRedundantCards(allTemplates()), []);
});

test('subscribable drift is reported in BOTH directions', () => {
  const templates = allTemplates();
  const plans = {};             // nothing carries a plan
  const products = byFile({ 'landing-page-lotion': ['coconut-lotion'] });
  const drift = subscribableDrift(products, plans, templates);
  const lotion = drift.find((d) => d.template === 'lotion');
  assert.equal(lotion.kind, 'false-claim', 'claims subscribable, nothing sells one');

  // ...and the other way: the refill's shape.
  const products2 = byFile({ 'landing-page-lip-balm': ['coconut-oil-lip-balm'] });
  const plans2 = { 'coconut-oil-lip-balm': true };
  const drift2 = subscribableDrift(products2, plans2, templates);
  assert.equal(drift2.find((d) => d.template === 'lip-balm').kind, 'withheld');
});

test('a per-product list must name exactly the handles that carry a plan', () => {
  const templates = allTemplates();
  const f = 'product.landing-page-liquid-soap.json';
  const handles = ['organic-foaming-hand-soap', 'foam-soap-refill-32oz'];
  const products = byFile({ 'landing-page-liquid-soap': handles });

  // Correct today: only the refill has a plan, and the manifest lists only it.
  const ok = subscribableDrift(products, { 'foam-soap-refill-32oz': true }, templates);
  assert.equal(ok.find((d) => d.file === f), undefined);

  // If the pump gains one, the conditional now gates the wrong set.
  const bad = subscribableDrift(products, { 'foam-soap-refill-32oz': true, 'organic-foaming-hand-soap': true }, templates);
  const hit = bad.find((d) => d.file === f);
  assert.equal(hit.kind, 'per-product-mismatch');
  assert.deepEqual(hit.real, [...handles].sort());
});

test('a template serving nothing is an ORPHAN, never "not subscribable"', () => {
  // Reading an empty product list as "nothing sells a plan" would fire a
  // false-claim on every template the catalogue query failed to cover.
  const drift = subscribableDrift({}, {}, allTemplates());
  assert.deepEqual(drift, [], 'no claim verdict without products');
  assert.equal(orphanTemplates({}).length, Object.keys(MANIFEST).length);
});

test('severity: a stale card or a claim is exit 2; drift and orphans are exit 1', () => {
  assert.equal(summarize({}).code, 0);
  assert.equal(summarize({ orphans: ['x'] }).code, 1);
  assert.equal(summarize({ builderChanges: [{ file: 'a', notes: [] }] }).code, 1);
  assert.equal(summarize({ drift: [{ template: 'x' }] }).code, 2);
  assert.equal(summarize({ stale: [{ template: 'x' }] }).code, 2);
});

test('the report names the fix, because it IS the digest body', () => {
  const body = renderReport(summarize({
    stale: [{ template: 't', file: 'f.json', product: 'p', tiers: ['a', 'b'] }],
    drift: [{ template: 'u', file: 'g.json', kind: 'withheld', subscribable: ['h'] }],
  }));
  assert.match(body, /build-product-templates\.mjs --apply/);
  assert.match(body, /dropSections/);
  assert.match(body, /withheld claim/);
});

test('the wrapper never writes and spawns only the DRY builder', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'check-pdp-template-drift.mjs'), 'utf8');
  assert.match(src, /BUILDER_ARGS = Object\.freeze\(\[\]\)/, 'args must be frozen and empty');
  assert.match(src, /--apply.*\n.*never writes/s);
  assert.match(src, /process\.exit\(64\)/);
  // The builder writes to the LIVE theme, so exactly one spawn, and no --apply.
  // Count INVOCATIONS, not the identifier — the import line mentions it too.
  assert.equal((src.match(/execFileSync\(/g) ?? []).length, 1);
  assert.doesNotMatch(src, /BUILDER_ARGS = Object\.freeze\(\[[^\]]*apply/);
  assert.ok(existsSync(join(ROOT, 'scripts', 'build-product-templates.mjs')));
});
