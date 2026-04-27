import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagCalendarItems, buildValidatedDemandSection } from '../../agents/content-strategist/index.js';

const idx = {
  keywords: {
    'natural-deodorant':     { slug: 'natural-deodorant',     keyword: 'natural deodorant',     validation_source: 'amazon' },
    'best-soap-for-tattoos': { slug: 'best-soap-for-tattoos', keyword: 'best soap for tattoos', validation_source: 'gsc_ga4' },
  },
};

test('tagCalendarItems stamps validation_source by keyword lookup', () => {
  const items = [
    { slug: 'natural-deodorant', keyword: 'natural deodorant' },
    { slug: 'best-soap-for-tattoos', keyword: 'best soap for tattoos' },
    { slug: 'unmapped', keyword: 'never seen before' },
  ];
  const out = tagCalendarItems(items, idx);
  assert.equal(out[0].validation_source, 'amazon');
  assert.equal(out[1].validation_source, 'gsc_ga4');
  assert.equal(out[2].validation_source, null);
});

test('tagCalendarItems handles null index', () => {
  const items = [{ keyword: 'x' }];
  const out = tagCalendarItems(items, null);
  assert.equal(out[0].validation_source, null);
});

test('buildValidatedDemandSection returns empty string when no entries', () => {
  assert.equal(buildValidatedDemandSection([]), '');
  assert.equal(buildValidatedDemandSection(null), '');
});

test('buildValidatedDemandSection groups amazon and gsc_ga4 entries', () => {
  const out = buildValidatedDemandSection([
    { keyword: 'a', validation_source: 'amazon', amazon: { purchases: 10 } },
    { keyword: 'b', validation_source: 'gsc_ga4', ga4: { conversions: 3 } },
  ]);
  assert.ok(out.includes('Amazon-validated:'));
  assert.ok(out.includes('GSC+GA4-validated:'));
  assert.ok(out.includes('"a"'));
  assert.ok(out.includes('"b"'));
});
