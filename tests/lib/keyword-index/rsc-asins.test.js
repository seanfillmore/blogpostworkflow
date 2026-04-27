import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { findLatestListingsDump, listRscAsinsFromDump } from '../../../lib/keyword-index/rsc-asins.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'keyword-index');

test('findLatestListingsDump returns null when explore directory does not exist', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rsc-asins-'));
  try {
    assert.equal(findLatestListingsDump(tmp), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findLatestListingsDump returns the most recent matching file by mtime', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rsc-asins-'));
  try {
    const dir = join(tmp, 'data', 'amazon-explore');
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, '2026-03-01-listings-prod.json');
    const newFile = join(dir, '2026-04-26-listings-prod.json');
    writeFileSync(oldFile, '{}');
    writeFileSync(newFile, '{}');
    // Force mtimes so the test is deterministic regardless of filesystem precision.
    utimesSync(oldFile, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));
    utimesSync(newFile, new Date('2026-04-26T00:00:00Z'), new Date('2026-04-26T00:00:00Z'));
    const latest = findLatestListingsDump(tmp);
    assert.equal(latest, newFile);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findLatestListingsDump ignores non-listings files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rsc-asins-'));
  try {
    const dir = join(tmp, 'data', 'amazon-explore');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sales-traffic.json'), '{}');
    writeFileSync(join(dir, 'README.md'), '');
    assert.equal(findLatestListingsDump(tmp), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('listRscAsinsFromDump returns empty array for missing file', () => {
  assert.deepEqual(listRscAsinsFromDump(null), []);
  assert.deepEqual(listRscAsinsFromDump('/nonexistent/path.json'), []);
});

test('listRscAsinsFromDump extracts ASINs and filters out Culina items', () => {
  const fixture = join(FIXTURES, 'listings', '2026-04-26-listings-prod.json');
  const result = listRscAsinsFromDump(fixture);
  // Fixture has: 2 RSC items, 1 Culina (cast iron), 1 empty summaries, 1 missing ASIN.
  // Expect only the 2 RSC ASINs.
  assert.deepEqual(result.sort(), ['B0RSCDEOW', 'B0RSCLOTION'].sort());
});

test('listRscAsinsFromDump handles items with missing summaries', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rsc-asins-'));
  try {
    const f = join(tmp, 'd.json');
    writeFileSync(f, JSON.stringify({
      items: [
        { sku: 'A' }, // no summaries
        { sku: 'B', summaries: [] }, // empty
        { sku: 'C', summaries: [{ itemName: 'No ASIN here' }] }, // no asin
        { sku: 'D', summaries: [{ asin: 'B0OK', itemName: 'REAL Lotion' }] },
      ],
    }));
    assert.deepEqual(listRscAsinsFromDump(f), ['B0OK']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('listRscAsinsFromDump returns empty array on malformed JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rsc-asins-'));
  try {
    const f = join(tmp, 'bad.json');
    writeFileSync(f, 'not json{{');
    assert.deepEqual(listRscAsinsFromDump(f), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
