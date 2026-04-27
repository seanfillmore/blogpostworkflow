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

import { briefQueueToCalendarItems } from '../../agents/content-strategist/index.js';

test('briefQueueToCalendarItems assigns sequential weeks (2 posts/week, Mon then Thu)', () => {
  const queue = [
    { keyword: 'a', title: 'A', category: 'cat' },
    { keyword: 'b', title: 'B', category: 'cat' },
    { keyword: 'c', title: 'C', category: 'cat' },
    { keyword: 'd', title: 'D', category: 'cat' },
  ];
  // Pin "today" to a known weekday (Sunday Apr 27 2025 UTC)
  const items = briefQueueToCalendarItems(queue, null, new Date('2025-04-27T00:00:00Z'));
  assert.equal(items[0].week, 1);
  assert.equal(items[1].week, 1);
  assert.equal(items[2].week, 2);
  assert.equal(items[3].week, 2);

  // First publish should be next Monday (Apr 28). Second is the same week's Thu (May 1).
  const d0 = new Date(items[0].publish_date);
  const d1 = new Date(items[1].publish_date);
  assert.equal(d0.getUTCDay(), 1, 'first item should publish on Monday');
  assert.equal(d1.getUTCDay(), 4, 'second item should publish on Thursday');
  assert.equal((d1 - d0) / (24 * 3600 * 1000), 3, '3-day gap Mon→Thu');
});

test('briefQueueToCalendarItems stamps validation_source via keyword-index', () => {
  const queue = [{ keyword: 'natural deodorant', title: 'X' }];
  const idx = { keywords: { 'natural-deodorant': { slug: 'natural-deodorant', keyword: 'natural deodorant', validation_source: 'amazon' } } };
  const items = briefQueueToCalendarItems(queue, idx, new Date('2025-04-27T00:00:00Z'));
  assert.equal(items[0].validation_source, 'amazon');
  assert.equal(items[0].priority, 'high');
});

test('briefQueueToCalendarItems uses normal priority when not Amazon-validated', () => {
  const queue = [{ keyword: 'no entry', title: 'X' }];
  const items = briefQueueToCalendarItems(queue, null, new Date('2025-04-27T00:00:00Z'));
  assert.equal(items[0].validation_source, null);
  assert.equal(items[0].priority, 'normal');
});

test('briefQueueToCalendarItems sets source to content_strategist', () => {
  const items = briefQueueToCalendarItems([{ keyword: 'a', title: 'A' }], null, new Date('2025-04-27T00:00:00Z'));
  assert.equal(items[0].source, 'content_strategist');
});

test('briefQueueToCalendarItems handles empty queue', () => {
  const items = briefQueueToCalendarItems([], null);
  assert.deepEqual(items, []);
});
