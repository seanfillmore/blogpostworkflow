import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isCompleteTail, listDumps, planPrune, requiredFreeBytes, RESERVE_BYTES, DEFAULT_DUMP_BYTES } from '../../../lib/amazon/ba-retention.js';
import { findLatestBaDump } from '../../../lib/keyword-index/dump-readers.js';

const GOOD = '{"dataByDepartmentAndSearchTerm":[{"clickShare" : 0.0400,    "conversionShare" : 0.0000  } ]}';
// The real 2026-11-08 file ended exactly like this: cut off mid-record by a full disk.
const CUT = '{"dataByDepartmentAndSearchTerm":[{"searchFrequencyRank" : 2730671,    "clickedAsin" : "B0H4LKYC37",    "click';

function dir(files) {
  const root = mkdtempSync(join(tmpdir(), 'ba-'));
  const d = join(root, 'data/amazon-explore');
  mkdirSync(d, { recursive: true });
  files.forEach(([name, body], i) => {
    writeFileSync(join(d, name), body);
    const t = new Date(Date.parse('2026-11-01T00:00:00Z') + i * 86400000);
    utimesSync(join(d, name), t, t);
  });
  return { root, d };
}

test('isCompleteTail: a finished dump ends with "]}"; a cut-off one does not', () => {
  assert.equal(isCompleteTail(GOOD.slice(-64)), true);
  assert.equal(isCompleteTail(GOOD.slice(-64) + '\n'), true);
  assert.equal(isCompleteTail(CUT.slice(-64)), false);
  assert.equal(isCompleteTail(''), false);
});

test('planPrune keeps only the newest COMPLETE dump; a truncated newer one and a leftover .partial go', () => {
  const { d } = dir([
    ['2026-10-18-brand-analytics-production.json', GOOD],
    ['2026-11-01-brand-analytics-production.json', GOOD],
    ['2026-11-08-brand-analytics-production.json', CUT],
    ['2026-11-09-brand-analytics-production.json.partial', CUT],
    ['2026-11-01-listings-production.json', '{}'],
  ]);
  const dumps = listDumps(d, 'production');
  assert.equal(dumps.length, 4, 'listings files are not BA dumps');
  assert.deepEqual(planPrune(dumps), {
    keep: ['2026-11-01-brand-analytics-production.json'],
    remove: ['2026-11-09-brand-analytics-production.json.partial', '2026-11-08-brand-analytics-production.json', '2026-10-18-brand-analytics-production.json'],
  });
});

test('planPrune never deletes the last complete dump, and keeps nothing when none is complete', () => {
  const { d } = dir([['2026-11-08-brand-analytics-production.json', CUT]]);
  assert.deepEqual(planPrune(listDumps(d, 'production')), { keep: [], remove: ['2026-11-08-brand-analytics-production.json'] });
});

test('requiredFreeBytes: last complete size plus 15% plus the reserve; a default when there is none', () => {
  assert.equal(requiredFreeBytes([{ complete: false, size: 1 }, { complete: true, size: 1000 }]), 1150 + RESERVE_BYTES);
  assert.equal(requiredFreeBytes([]), Math.round(DEFAULT_DUMP_BYTES * 1.15) + RESERVE_BYTES);
});

test('findLatestBaDump skips a truncated newer dump and returns the newest complete one', () => {
  const { root } = dir([
    ['2026-11-01-brand-analytics-production.json', GOOD],
    ['2026-11-08-brand-analytics-production.json', CUT],
  ]);
  assert.match(findLatestBaDump(root), /2026-11-01-brand-analytics/);
});

test('findLatestBaDump ignores a .partial file being written', () => {
  const { root } = dir([
    ['2026-11-01-brand-analytics-production.json', GOOD],
    ['2026-11-08-brand-analytics-production.json.partial', GOOD],
  ]);
  assert.match(findLatestBaDump(root), /2026-11-01-brand-analytics-production\.json$/);
});
