import { strict as assert } from 'node:assert';
import {
  getWeekWindow,
  aggregateAdSnapshots,
  aggregateAppliedChanges,
  computeDelta,
} from '../../scripts/ads-weekly-recap.js';

// getWeekWindow — returns 7 dates ending on the given endDate (Sun–Sat of prior week)
const window = getWeekWindow('2026-03-22'); // Sunday Mar 22 → window is Mar 15–Mar 21
assert.equal(window.length, 7);
assert.equal(window[0], '2026-03-15');
assert.equal(window[6], '2026-03-21');

// aggregateAdSnapshots
const snaps = [
  { spend: 9.10, clicks: 14, conversions: 1, revenue: 22, impressions: 300 },
  { spend: 8.50, clicks: 12, conversions: 0, revenue: 0, impressions: 250 },
];
const totals = aggregateAdSnapshots(snaps);
assert.equal(totals.spend, 17.60);
assert.equal(totals.clicks, 26);
assert.equal(totals.conversions, 1);
assert.equal(totals.revenue, 22);

// aggregateAdSnapshots — empty array
const empty = aggregateAdSnapshots([]);
assert.equal(empty.spend, 0);

// aggregateAppliedChanges — counts applied suggestions across multiple files
const suggestionFiles = [
  { suggestions: [
    { status: 'applied', type: 'keyword_pause' },
    { status: 'applied', type: 'negative_add' },
    { status: 'pending', type: 'copy_rewrite' },
  ]},
  { suggestions: [
    { status: 'applied', type: 'copy_rewrite' },
  ]},
];
const counts = aggregateAppliedChanges(suggestionFiles);
assert.equal(counts.total, 3);
assert.equal(counts.keyword_pause, 1);
assert.equal(counts.negative_add, 1);
assert.equal(counts.copy_rewrite, 1);

// computeDelta — positive and negative
const delta = computeDelta({ spend: 67, conversions: 4, cpa: 16.75 }, { spend: 63, conversions: 3, cpa: 21 });
assert.ok(delta.spend.startsWith('+'), 'spend increased');
assert.equal(delta.conversions, '+1');
assert.ok(delta.cpa.startsWith('-'), 'cpa improved');

// countOrganicOverlap — paid keywords that rank top-3 organically
const { countOrganicOverlap } = await import('../../scripts/ads-weekly-recap.js');
const keywords = [{ keyword: 'natural lotion' }, { keyword: 'coconut oil lotion' }, { keyword: 'body butter' }];
const gscQueries = [
  { query: 'natural lotion', position: 2.1 },
  { query: 'coconut oil lotion', position: 8.4 },
  { query: 'body butter', position: 1.0 },
];
assert.equal(countOrganicOverlap(keywords, gscQueries), 2, 'two keywords rank top-3 organically');
assert.equal(countOrganicOverlap(keywords, []), 0, 'no overlap when no GSC data');

console.log('✓ ads-weekly-recap pure function tests pass');
