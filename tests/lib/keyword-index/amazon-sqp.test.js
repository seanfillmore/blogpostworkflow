import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSqpReport, mergeSqpReports } from '../../../lib/keyword-index/amazon-sqp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'keyword-index', 'sqp', 'sample-asin-report.json');

test('parseSqpReport returns per-query metrics keyed by normalized query', () => {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const parsed = parseSqpReport(raw);
  assert.ok(parsed['natural deodorant for women']);
  assert.equal(parsed['natural deodorant for women'].asin, 'B0FAKERSC');
  assert.equal(parsed['natural deodorant for women'].impressions, 1240);
  assert.equal(parsed['natural deodorant for women'].clicks, 96);
  assert.equal(parsed['natural deodorant for women'].add_to_cart, 56);
  assert.equal(parsed['natural deodorant for women'].purchases, 38);
});

test('parseSqpReport handles empty dataByAsin', () => {
  const parsed = parseSqpReport({ asin: 'B0', dataByAsin: [] });
  assert.deepEqual(parsed, {});
});

test('mergeSqpReports sums metrics across multiple ASINs for the same query', () => {
  const a = parseSqpReport(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  const bRaw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  bRaw.asin = 'B0SECONDRSC';
  bRaw.dataByAsin = bRaw.dataByAsin.map((d) => ({ ...d, asin: 'B0SECONDRSC' }));
  const b = parseSqpReport(bRaw);
  const merged = mergeSqpReports([a, b]);
  // Both reports contribute 96 clicks each → 192 for "natural deodorant for women"
  assert.equal(merged['natural deodorant for women'].clicks, 192);
  // asins array contains both
  assert.equal(merged['natural deodorant for women'].asins.length, 2);
});
