import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAhrefsOverview } from '../../lib/ahrefs-parser.js';

test('parses standard Ahrefs domain overview CSV', () => {
  const csv = `Domain Rating,Backlinks,Referring Domains,Organic Traffic Value\n72,1240,310,45600`;
  const result = parseAhrefsOverview(csv);
  assert.equal(result.domainRating, '72');
  assert.equal(result.backlinks, '1240');
  assert.equal(result.referringDomains, '310');
  assert.equal(result.organicTrafficValue, '45600');
});

test('handles missing columns gracefully', () => {
  const csv = `Domain Rating,Some Other Column\n72,foo`;
  const result = parseAhrefsOverview(csv);
  assert.equal(result.domainRating, '72');
  assert.equal(result.backlinks, null);
  assert.equal(result.referringDomains, null);
  assert.equal(result.organicTrafficValue, null);
});

test('returns null for empty or invalid CSV', () => {
  assert.equal(parseAhrefsOverview(''), null);
  assert.equal(parseAhrefsOverview('just a header\n'), null);
});

test('is case-insensitive for column names', () => {
  const csv = `domain rating,BACKLINKS,referring domains,organic traffic value\n55,800,200,12000`;
  const result = parseAhrefsOverview(csv);
  assert.equal(result.domainRating, '55');
  assert.equal(result.backlinks, '800');
});
