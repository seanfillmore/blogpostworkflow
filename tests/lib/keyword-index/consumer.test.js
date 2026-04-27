import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIndex, lookupByKeyword, _resetCacheForTests } from '../../../lib/keyword-index/consumer.js';

test('loadIndex returns null when file missing', () => {
  _resetCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), 'kwi-'));
  try {
    assert.equal(loadIndex(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex parses a valid keyword-index.json', () => {
  _resetCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), 'kwi-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'keyword-index.json'), JSON.stringify({
      built_at: '2026-04-27T00:00:00.000Z',
      keywords: { 'foo': { keyword: 'foo', slug: 'foo', cluster: 'soap', validation_source: 'amazon' } },
    }));
    const idx = loadIndex(dir);
    assert.equal(idx.keywords.foo.cluster, 'soap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const lookupFixture = {
  keywords: {
    'natural-deodorant':     { keyword: 'natural deodorant',     slug: 'natural-deodorant',     validation_source: 'amazon' },
    'best-soap-for-tattoos': { keyword: 'best soap for tattoos', slug: 'best-soap-for-tattoos', validation_source: 'gsc_ga4' },
  },
};

test('lookupByKeyword exact slug match', () => {
  const e = lookupByKeyword(lookupFixture, 'natural-deodorant');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('lookupByKeyword normalized-slug match from raw keyword', () => {
  const e = lookupByKeyword(lookupFixture, 'Natural Deodorant');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('lookupByKeyword case-insensitive fallback', () => {
  const e = lookupByKeyword(lookupFixture, 'BEST SOAP FOR TATTOOS!');
  assert.equal(e?.slug, 'best-soap-for-tattoos');
});

test('lookupByKeyword miss returns null', () => {
  assert.equal(lookupByKeyword(lookupFixture, 'something we never see'), null);
});

test('lookupByKeyword null index returns null', () => {
  assert.equal(lookupByKeyword(null, 'foo'), null);
});
