import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { aggregateGSCForUrl, aggregateGA4ForUrl } from '../../lib/change-log/snapshots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'change-log', 'snapshots');

test('aggregateGSCForUrl sums impressions/clicks and means CTR/position over date range', () => {
  const result = aggregateGSCForUrl({
    snapshotsDir: join(FIXTURES, 'gsc'),
    url: 'https://www.realskincare.com/products/coconut-lotion',
    queries: ['coconut lotion'],
    fromDate: '2026-04-01',
    toDate: '2026-04-05',
  });
  // Page-level: sum impressions = 550, sum clicks = 35, mean position = (7.5+7+6.5+6.8+6)/5 = 6.76
  assert.equal(result.page.impressions, 550);
  assert.equal(result.page.clicks, 35);
  assert.equal(result.page.position.toFixed(2), '6.76');
  // CTR is computed from totals: 35 / 550 = 0.0636
  assert.equal(result.page.ctr.toFixed(4), '0.0636');
  // Query-level: present
  assert.ok(result.byQuery['coconut lotion']);
  assert.ok(result.byQuery['coconut lotion'].impressions > 0);
});

test('aggregateGSCForUrl returns zeroes for URL with no data', () => {
  const result = aggregateGSCForUrl({
    snapshotsDir: join(FIXTURES, 'gsc'),
    url: 'https://www.realskincare.com/products/missing',
    queries: [],
    fromDate: '2026-04-01',
    toDate: '2026-04-05',
  });
  assert.equal(result.page.impressions, 0);
  assert.equal(result.page.clicks, 0);
});

test('aggregateGA4ForUrl sums sessions/conversions/revenue', () => {
  const result = aggregateGA4ForUrl({
    snapshotsDir: join(FIXTURES, 'ga4'),
    pagePath: '/products/coconut-lotion',
    fromDate: '2026-04-01',
    toDate: '2026-04-05',
  });
  // sum sessions = 50+55+60+52+58 = 275
  assert.equal(result.sessions, 275);
  assert.equal(result.conversions, 2 + 2 + 3 + 3 + 4);
  assert.equal(result.page_revenue, 60 + 60 + 90 + 90 + 120);
});

test('aggregateGA4ForUrl returns zeroes for missing page', () => {
  const result = aggregateGA4ForUrl({
    snapshotsDir: join(FIXTURES, 'ga4'),
    pagePath: '/products/missing',
    fromDate: '2026-04-01',
    toDate: '2026-04-05',
  });
  assert.equal(result.sessions, 0);
  assert.equal(result.conversions, 0);
  assert.equal(result.page_revenue, 0);
});

test('aggregateGSCForUrl reads query rows from queriesByPage, the field real snapshots carry', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'gsc-'));
  const page = 'https://www.realskincare.com/blogs/news/toothpaste-without-sls-what-to-know-best-options';
  writeFileSync(join(dir, '2026-09-01.json'), JSON.stringify({
    date: '2026-09-01',
    topPages: [{ page, clicks: 30, impressions: 3698, position: 5.2 }],
    queriesByPage: [{ query: 'sls free toothpaste', page, clicks: 9, impressions: 538, position: 4.2 }],
  }));
  const r = aggregateGSCForUrl({
    snapshotsDir: dir,
    url: '/blogs/news/toothpaste-without-sls-what-to-know-best-options',
    queries: ['sls free toothpaste'],
    fromDate: '2026-09-01',
    toDate: '2026-09-01',
  });
  assert.equal(r.page.impressions, 3698, 'a blog path must match its GSC row');
  assert.equal(r.byQuery['sls free toothpaste'].impressions, 538);
});
