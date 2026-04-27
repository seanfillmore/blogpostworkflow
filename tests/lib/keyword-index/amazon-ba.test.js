import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBaReportStream } from '../../../lib/keyword-index/amazon-ba.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'keyword-index', 'ba', 'sample-search-terms.jsonl');

test('parseBaReportStream filters to entries containing an RSC ASIN', async () => {
  const rscAsins = new Set(['B0FAKERSC']);
  const result = await parseBaReportStream({ filePath: FIXTURE, rscAsins });
  // Of 3 fixture entries, 2 contain B0FAKERSC and should be kept.
  assert.equal(Object.keys(result).length, 2);
  assert.ok(result['natural deodorant for women']);
  assert.ok(result['coconut lotion']);
  assert.equal(result['car battery'], undefined);
});

test('parseBaReportStream returns search frequency rank + competitor list', async () => {
  const rscAsins = new Set(['B0FAKERSC']);
  const result = await parseBaReportStream({ filePath: FIXTURE, rscAsins });
  const entry = result['natural deodorant for women'];
  assert.equal(entry.search_frequency_rank, 12345);
  // Competitors are non-RSC ASINs from the top-3 clicked list
  assert.equal(entry.competitors.length, 2);
  assert.equal(entry.competitors[0].asin, 'B0NATIVE');
  assert.equal(entry.competitors[0].click_share, 0.18);
  assert.equal(entry.competitors[0].brand, 'Native Deodorant'); // pulled from productTitle
});

test('parseBaReportStream returns empty when no RSC ASINs match', async () => {
  const rscAsins = new Set(['B0NOMATCH']);
  const result = await parseBaReportStream({ filePath: FIXTURE, rscAsins });
  assert.deepEqual(result, {});
});

test('parseBaReportStream skips malformed lines', async () => {
  // Use a temp file with a bad line in the middle
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'ba-test-'));
  const path = join(tmp, 'with-bad.jsonl');
  writeFileSync(path,
    '{"searchTerm":"a","clickedAsin1":"B0FAKERSC","clickShare1":0.1}\n' +
    'NOT JSON\n' +
    '{"searchTerm":"b","clickedAsin1":"B0FAKERSC","clickShare1":0.1}\n'
  );
  const rscAsins = new Set(['B0FAKERSC']);
  const result = await parseBaReportStream({ filePath: path, rscAsins });
  assert.equal(Object.keys(result).length, 2);
});
