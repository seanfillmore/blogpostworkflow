import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { findLatestSqpDump, findLatestBaDump, parseSqpDump, readUntappedCandidates } from '../../../lib/keyword-index/dump-readers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'keyword-index');

test('findLatestSqpDump returns null when explore dir missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dump-readers-'));
  try {
    assert.equal(findLatestSqpDump(tmp), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findLatestSqpDump matches *-search-query-performance-*.json', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dump-readers-'));
  try {
    const dir = join(tmp, 'data', 'amazon-explore');
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, '2026-03-01-search-query-performance-production.json');
    const newFile = join(dir, '2026-04-26-search-query-performance-production.json');
    const baFile = join(dir, '2026-04-27-brand-analytics-production.json');
    writeFileSync(oldFile, '{}');
    writeFileSync(newFile, '{}');
    writeFileSync(baFile, '{}');
    utimesSync(oldFile, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));
    utimesSync(newFile, new Date('2026-04-26T00:00:00Z'), new Date('2026-04-26T00:00:00Z'));
    utimesSync(baFile, new Date('2026-04-27T00:00:00Z'), new Date('2026-04-27T00:00:00Z'));
    assert.equal(findLatestSqpDump(tmp), newFile);
    assert.equal(findLatestBaDump(tmp), baFile);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findLatestSqpDump skips an empty newest dump for an older one with rows', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dump-readers-'));
  try {
    const dir = join(tmp, 'data', 'amazon-explore');
    mkdirSync(dir, { recursive: true });
    const good = join(dir, '2026-05-01-search-query-performance-production.json'); // older, has rows
    const empty = join(dir, '2026-06-14-search-query-performance-production.json'); // newest, FATAL → no rows
    writeFileSync(good, JSON.stringify({ rows: [{ asin: 'B0X', searchQueryData: { searchQuery: 'k' } }] }));
    writeFileSync(empty, JSON.stringify({ rows: [] }));
    utimesSync(good, new Date('2026-05-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
    utimesSync(empty, new Date('2026-06-14T00:00:00Z'), new Date('2026-06-14T00:00:00Z'));
    // newest is empty → must fall back to the older dump that actually has rows
    assert.equal(findLatestSqpDump(tmp), good);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseSqpDump returns empty for empty / malformed dumps', () => {
  assert.deepEqual(parseSqpDump(null), {});
  assert.deepEqual(parseSqpDump({}), {});
  assert.deepEqual(parseSqpDump({ rows: 'not array' }), {});
});

test('parseSqpDump produces per-query map matching mergeSqpReports shape', () => {
  const dump = JSON.parse(readFileSync(join(FIXTURES, 'sqp', 'sample-explore-dump.json'), 'utf8'));
  const result = parseSqpDump(dump);

  // 'natural deodorant for women' has rows from B0FAKERSC and B0SECONDRSC
  assert.ok(result['natural deodorant for women']);
  // impressions summed across both ASINs: 1240 + 800 = 2040
  assert.equal(result['natural deodorant for women'].impressions, 1240 + 800);
  // clicks summed: 96 + 40 = 136
  assert.equal(result['natural deodorant for women'].clicks, 96 + 40);
  // purchases summed: 38 + 12 = 50
  assert.equal(result['natural deodorant for women'].purchases, 38 + 12);
  // asins array contains both
  assert.equal(result['natural deodorant for women'].asins.length, 2);
  // CVR recomputed from totals: 50 / 136
  assert.equal(result['natural deodorant for women'].cvr.toFixed(4), (50 / 136).toFixed(4));

  // 'coconut lotion' only from one ASIN
  assert.ok(result['coconut lotion']);
  assert.equal(result['coconut lotion'].asins.length, 1);
});

test('parseSqpDump skips rows without asin', () => {
  const result = parseSqpDump({
    rows: [
      { searchQueryData: { searchQuery: 'no asin' }, clickData: { asinClickCount: 5 }, purchaseData: { asinPurchaseCount: 1 } },
      { asin: 'B0OK', searchQueryData: { searchQuery: 'kw' }, clickData: { asinClickCount: 5 }, purchaseData: { asinPurchaseCount: 1 } },
    ],
  });
  assert.equal(Object.keys(result).length, 1);
  assert.ok(result['kw']);
});

function writeCandidates(tmp, generatedAt, candidates) {
  const dir = join(tmp, 'data', 'reports', 'gsc-query-miner');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'untapped-candidates.json'), JSON.stringify({
    generated_at: generatedAt,
    source: 'gsc-query-miner',
    candidates,
  }));
  return dir;
}

const NOW = new Date('2026-07-27T00:00:00Z');
const SAMPLE = [{ keyword: 'coconut for the skin', impressions: 536, position: 11.8, reason: 'impression_leak' }];

test('readUntappedCandidates returns candidates from a fresh file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    writeCandidates(tmp, '2026-07-26T00:00:00Z', SAMPLE);
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'ok');
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].keyword, 'coconut for the skin');
    assert.equal(r.ageDays, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates reports missing when the file is absent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'missing');
    assert.deepEqual(r.candidates, []);
    assert.equal(r.ageDays, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates rejects a file older than maxAgeDays, returning no candidates', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    writeCandidates(tmp, '2026-06-01T00:00:00Z', SAMPLE);
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'stale');
    assert.deepEqual(r.candidates, []);
    assert.equal(r.ageDays, 56);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates measures age from generated_at, not file mtime', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    const dir = writeCandidates(tmp, '2026-06-01T00:00:00Z', SAMPLE);
    // Touch the file to "now" — a git checkout does exactly this.
    const f = join(dir, 'untapped-candidates.json');
    utimesSync(f, NOW, NOW);
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'stale');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates treats malformed JSON as malformed, not a throw', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    const dir = join(tmp, 'data', 'reports', 'gsc-query-miner');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'untapped-candidates.json'), '{ not json');
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'malformed');
    assert.deepEqual(r.candidates, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates treats a missing generated_at as malformed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    const dir = join(tmp, 'data', 'reports', 'gsc-query-miner');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'untapped-candidates.json'), JSON.stringify({ candidates: SAMPLE }));
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'malformed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
