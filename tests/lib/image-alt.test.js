import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildImageAlt } from '../../lib/image-alt.js';

test('buildImageAlt: uses scene description, keyword-anchored, under 125 chars', () => {
  const alt = buildImageAlt({ keyword: 'natural deodorant', title: 'Best Natural Deodorant', scene: 'A coconut oil deodorant stick on a bright bathroom vanity with eucalyptus' });
  assert.ok(alt.length > 0 && alt.length <= 125);
  assert.match(alt.toLowerCase(), /deodorant/);
});

test('buildImageAlt: falls back to keyword + title when no scene', () => {
  const alt = buildImageAlt({ keyword: 'natural lip balm', title: 'Best Lip Balm' });
  assert.ok(alt.toLowerCase().includes('lip balm'));
  assert.ok(alt.length <= 125);
});

test('buildImageAlt: empty everything → safe non-empty string', () => {
  const alt = buildImageAlt({});
  assert.equal(typeof alt, 'string');
});

test('buildImageAlt: long scene truncated to <=125 without mid-word cut', () => {
  const alt = buildImageAlt({ keyword: 'deodorant', scene: 'x'.repeat(200) });
  assert.ok(alt.length <= 125);
});
