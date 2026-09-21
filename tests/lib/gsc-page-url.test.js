import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gscPageUrl, CANONICAL_ORIGIN } from '../../lib/gsc-page-url.js';

test('the myshopify host every post stores is rewritten to the host GSC indexed', () => {
  assert.equal(
    gscPageUrl('https://realskincare-com.myshopify.com/blogs/news/antibacterial-body-soap-what-to-look-for-why-it-matters'),
    'https://www.realskincare.com/blogs/news/antibacterial-body-soap-what-to-look-for-why-it-matters',
  );
});

test('apex, http and fragments normalise; path and query survive', () => {
  assert.equal(gscPageUrl('http://realskincare.com/products/x?variant=1#top'), 'https://www.realskincare.com/products/x?variant=1');
  assert.equal(gscPageUrl('https://www.realskincare.com/collections/y'), 'https://www.realskincare.com/collections/y');
});

test('a host we do not own is never rewritten', () => {
  assert.equal(gscPageUrl('https://example.com/blogs/news/x'), 'https://example.com/blogs/news/x');
  assert.equal(gscPageUrl('not a url'), 'not a url');
  assert.equal(gscPageUrl(''), '');
});

test('matches config/site.json', () => {
  const site = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../config/site.json'), 'utf8'));
  assert.equal(CANONICAL_ORIGIN, site.url.replace(/\/$/, ''));
});

test('every page-level GSC filter in lib/gsc.js goes through gscPageUrl', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../lib/gsc.js'), 'utf8');
  assert.equal((src.match(/dimension: 'page', operator: 'equals'/g) || []).length,
    (src.match(/dimension: 'page', operator: 'equals', expression: gscPageUrl\(/g) || []).length);
});
