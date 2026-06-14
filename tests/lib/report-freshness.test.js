import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseLatestReport, DEFAULT_MAX_REPORT_AGE_MS } from '../../lib/report-freshness.js';

const HOUR = 3600 * 1000;
const now = 1_000_000_000_000; // fixed clock

test('picks the newest .md within the freshness window', () => {
  const entries = [
    { name: 'old.md', mtimeMs: now - 50 * HOUR },
    { name: 'fresh.md', mtimeMs: now - 1 * HOUR },
    { name: 'mid.md', mtimeMs: now - 10 * HOUR },
  ];
  const r = chooseLatestReport(entries, { now });
  assert.deepEqual(r, { kind: 'report', name: 'fresh.md' });
});

test('ignores non-.md files', () => {
  const entries = [
    { name: 'latest.json', mtimeMs: now - 1 * HOUR },
    { name: 'notes.txt', mtimeMs: now - 1 * HOUR },
    { name: 'report.md', mtimeMs: now - 2 * HOUR },
  ];
  const r = chooseLatestReport(entries, { now });
  assert.deepEqual(r, { kind: 'report', name: 'report.md' });
});

test('returns "none" when there are no .md files', () => {
  const entries = [{ name: 'latest.json', mtimeMs: now }];
  assert.deepEqual(chooseLatestReport(entries, { now }), { kind: 'none' });
});

test('returns "none" for an empty/undefined listing', () => {
  assert.deepEqual(chooseLatestReport([], { now }), { kind: 'none' });
  assert.deepEqual(chooseLatestReport(undefined, { now }), { kind: 'none' });
});

test('returns "stale" when the newest report is older than the window', () => {
  // This is the Product-Optimizer "May 2" bug: the agent ran but wrote no fresh
  // report, so the latest .md on disk is weeks old and must not be surfaced.
  const entries = [{ name: 'product-optimizer-report.md', mtimeMs: now - 40 * 24 * HOUR }];
  assert.deepEqual(chooseLatestReport(entries, { now }), { kind: 'stale' });
});

test('a report exactly at the window boundary is still fresh', () => {
  const entries = [{ name: 'r.md', mtimeMs: now - DEFAULT_MAX_REPORT_AGE_MS }];
  assert.deepEqual(chooseLatestReport(entries, { now }), { kind: 'report', name: 'r.md' });
});

test('custom maxAgeMs is respected', () => {
  const entries = [{ name: 'r.md', mtimeMs: now - 2 * HOUR }];
  assert.deepEqual(chooseLatestReport(entries, { now, maxAgeMs: 1 * HOUR }), { kind: 'stale' });
  assert.deepEqual(chooseLatestReport(entries, { now, maxAgeMs: 3 * HOUR }), { kind: 'report', name: 'r.md' });
});
