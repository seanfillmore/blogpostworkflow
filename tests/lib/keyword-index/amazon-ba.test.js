import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBaReport } from '../../../lib/keyword-index/amazon-ba.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'keyword-index', 'ba', 'sample-search-terms.json');

test('parseBaReport filters to searchTerms whose top-clicked ASINs include an RSC', async () => {
  const rscAsins = new Set(['B0FAKERSC']);
  const result = await parseBaReport({ filePath: FIXTURE, rscAsins });
  // Of 3 fixture searchTerms (×3 rows each = 9 rows), 2 have B0FAKERSC in top-3.
  assert.equal(Object.keys(result).length, 2);
  assert.ok(result['natural deodorant for women']);
  assert.ok(result['coconut lotion']);
  assert.equal(result['car battery'], undefined);
});

test('parseBaReport returns search_frequency_rank + competitors sorted by clickShareRank', async () => {
  const rscAsins = new Set(['B0FAKERSC']);
  const result = await parseBaReport({ filePath: FIXTURE, rscAsins });
  const entry = result['natural deodorant for women'];
  assert.equal(entry.search_frequency_rank, 12345);
  // Competitors are non-RSC ASINs (excludes B0FAKERSC), sorted by clickShareRank ascending
  assert.equal(entry.competitors.length, 2);
  assert.equal(entry.competitors[0].asin, 'B0NATIVE');
  assert.equal(entry.competitors[0].click_share, 0.18);
  assert.equal(entry.competitors[0].conversion_share, 0.21);
  assert.equal(entry.competitors[0].brand, 'Native Deodorant');
  assert.equal(entry.competitors[1].asin, 'B0DOVE');
});

test('parseBaReport returns empty when no RSC ASINs match', async () => {
  const rscAsins = new Set(['B0NOMATCH']);
  const result = await parseBaReport({ filePath: FIXTURE, rscAsins });
  assert.deepEqual(result, {});
});

test('parseBaReport returns empty when file does not exist', async () => {
  const result = await parseBaReport({ filePath: '/nonexistent/path.json', rscAsins: new Set() });
  assert.deepEqual(result, {});
});

test('parseBaReport handles a searchTerm whose RSC clickShareRank is not 1', async () => {
  // Synthetic case: RSC is rank 2 (not the top-clicked) — should still qualify the search term.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'ba-test-'));
  try {
    const path = join(tmp, 'rank2.json');
    writeFileSync(path, JSON.stringify({
      dataByDepartmentAndSearchTerm: [
        { searchTerm: 'kw', searchFrequencyRank: 1, clickedAsin: 'B0COMPETITOR', clickedItemName: 'Competitor', clickShareRank: 1, clickShare: 0.40, conversionShare: 0.30 },
        { searchTerm: 'kw', searchFrequencyRank: 1, clickedAsin: 'B0FAKERSC',     clickedItemName: 'RSC product',  clickShareRank: 2, clickShare: 0.20, conversionShare: 0.15 },
      ],
    }));
    const result = await parseBaReport({ filePath: path, rscAsins: new Set(['B0FAKERSC']) });
    assert.ok(result['kw']);
    assert.equal(result['kw'].competitors.length, 1);
    assert.equal(result['kw'].competitors[0].asin, 'B0COMPETITOR');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
