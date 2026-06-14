import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateCollectionSpec } from '../../lib/collection-validation.js';

const good = {
  title: 'Natural Deodorant',
  handle: 'natural-deodorant',
  seo_title: 'Natural Deodorant | Real Skin Care',
  meta_description: 'Aluminum-free natural deodorant that actually works, made with coconut oil and clean ingredients for all-day freshness.',
  body_html: '<p>' + 'word '.repeat(320) + '</p>',
};

test('valid spec passes', () => {
  const r = validateCollectionSpec(good, { existingHandles: new Set() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('rejects sentinel/non-title values', () => {
  for (const t of ['DISQUALIFIED', 'NOT APPROVED', 'N/A', 'NONE', '']) {
    const r = validateCollectionSpec({ ...good, title: t }, { existingHandles: new Set() });
    assert.equal(r.ok, false, `should reject title "${t}"`);
  }
});

test('rejects missing / unslugifiable / duplicate handle', () => {
  assert.equal(validateCollectionSpec({ ...good, handle: '' }, { existingHandles: new Set() }).ok, false);
  assert.equal(validateCollectionSpec({ ...good, handle: '!!!' }, { existingHandles: new Set() }).ok, false);
  assert.equal(validateCollectionSpec(good, { existingHandles: new Set(['natural-deodorant']) }).ok, false);
});

test('rejects thin body_html (< 300 words)', () => {
  const r = validateCollectionSpec({ ...good, body_html: '<p>too short</p>' }, { existingHandles: new Set() });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /word|thin|short/i.test(e)));
});

test('rejects out-of-range seo_title and meta_description lengths', () => {
  assert.equal(validateCollectionSpec({ ...good, seo_title: 'x'.repeat(80) }, { existingHandles: new Set() }).ok, false);
  assert.equal(validateCollectionSpec({ ...good, meta_description: 'short' }, { existingHandles: new Set() }).ok, false);
  assert.equal(validateCollectionSpec({ ...good, meta_description: 'x'.repeat(200) }, { existingHandles: new Set() }).ok, false);
});

test('missing body_html fails', () => {
  const r = validateCollectionSpec({ ...good, body_html: undefined }, { existingHandles: new Set() });
  assert.equal(r.ok, false);
});
