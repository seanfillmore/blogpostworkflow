// Reachability is what stopped agents/cannibalization-resolver naming a DEAD
// page as the canonical winner of a live cluster. Every case here is built from
// the real production shapes measured on 2026-09-09.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  urlPath, buildReachableIndex, checkReachable, filterReachableRows, reachabilityBanner,
} from '../../lib/reachable-pages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The real shape: a draft article whose handle ALSO carries a redirect, and a
// live article that GSC ranks well — the pair the resolver got backwards.
const ARTICLES = [
  { handle: 'best-sls-free-toothpaste-2025', published_at: null },                     // draft
  { handle: 'best-toothpaste-without-sls-2025', published_at: '2026-03-20T08:00:00Z' }, // live
  { handle: 'toothpaste-without-sls-what-to-know-best-options', published_at: '2026-02-01T08:00:00Z' },
  { handle: 'benefits-of-using-coconut-oil-lotion', published_at: null },              // draft (lotion)
];
const REDIRECTS = [
  { path: '/blogs/news/best-sls-free-toothpaste-2025' },
  { path: '/blogs/news/sls-free-toothpaste-the-gentle-switch-worth-making' },
  { path: '/collections/sls-free-toothpaste' },
];
const INDEX = buildReachableIndex({ articles: ARTICLES, redirects: REDIRECTS });

const u = (h) => `https://www.realskincare.com/blogs/news/${h}`;

test('urlPath normalises absolute URLs, bare paths and trailing slashes', () => {
  assert.equal(urlPath('https://www.realskincare.com/blogs/news/a'), '/blogs/news/a');
  assert.equal(urlPath('https://www.realskincare.com/blogs/news/a/'), '/blogs/news/a');
  assert.equal(urlPath('/blogs/news/a?x=1#y'), '/blogs/news/a');
  assert.equal(urlPath(''), '');
});

test('a DRAFT article is unreachable', () => {
  const r = checkReachable(u('best-sls-free-toothpaste-2025'), INDEX);
  assert.equal(r.reachable, false);
});

test('a REDIRECTED path is unreachable, whatever its type', () => {
  // The blog case, and the collection case — /collections/sls-free-toothpaste
  // drew 1,393 impressions at position 49.6 while redirecting to a product.
  assert.equal(checkReachable(u('sls-free-toothpaste-the-gentle-switch-worth-making'), INDEX).reachable, false);
  assert.equal(checkReachable('/collections/sls-free-toothpaste', INDEX).reachable, false);
});

test('THE PAGE THE RESOLVER TRIED TO DESTROY IS REACHABLE', () => {
  // best-toothpaste-without-sls-2025: live, 26,860 impressions, 140 clicks, and
  // marked REDIRECT in four separate decisions in favour of a dead page. If this
  // ever returns false the filter has become the bug it was built to prevent.
  const r = checkReachable(u('best-toothpaste-without-sls-2025'), INDEX);
  assert.equal(r.reachable, true);
  assert.equal(r.reason, null);
});

test('an unknown handle is reachable — unknown never means unreachable', () => {
  // Same whitelist doctrine as PRODUCT_NOUNS: a page this index has never heard
  // of must pass, or one stale fetch silently deletes a cluster from detection.
  assert.equal(checkReachable(u('a-post-nobody-told-us-about'), INDEX).reachable, true);
  assert.equal(checkReachable('/products/coconut-oil-toothpaste', INDEX).reachable, true);
});

test('a NULL index passes everything — it degrades, it does not block', () => {
  for (const url of [u('best-sls-free-toothpaste-2025'), '/collections/sls-free-toothpaste']) {
    assert.equal(checkReachable(url, null).reachable, true,
      'a failed fetch must leave the agent behaving exactly as it did before');
  }
  assert.equal(buildReachableIndex({ articles: null, redirects: [] }), null);
  assert.equal(buildReachableIndex({}), null);
});

test('filterReachableRows keeps the live rows and REPORTS what it dropped', () => {
  const rows = [
    { query: 'best sls free toothpaste', page: u('toothpaste-without-sls-what-to-know-best-options'), impressions: 1617 },
    { query: 'best sls free toothpaste', page: u('best-toothpaste-without-sls-2025'), impressions: 1406 },
    { query: 'best sls free toothpaste', page: u('best-sls-free-toothpaste-2025'), impressions: 149 },
    { query: 'sls free toothpaste', page: u('best-sls-free-toothpaste-2025'), impressions: 800 },
  ];
  const { kept, dropped } = filterReachableRows(rows, INDEX);

  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 1, 'one PAGE, not one row — the two rows collapse');
  assert.equal(dropped[0].impressions, 949, 'impressions are summed across its queries');
  assert.equal(dropped[0].queries, 2);
  // Dropped rows are returned rather than discarded: a page still drawing
  // impressions while unreachable is itself the finding.
  assert.match(dropped[0].page, /best-sls-free-toothpaste-2025/);
});

test('a group left with fewer than two reachable pages stops being a conflict', () => {
  // The detectors already require >= 2 pages per query, so filtering first is
  // what makes a one-real-page "conflict" disappear instead of being triaged.
  const rows = [
    { query: 'q', page: u('best-toothpaste-without-sls-2025'), impressions: 100 },
    { query: 'q', page: u('best-sls-free-toothpaste-2025'), impressions: 90 },
  ];
  const { kept } = filterReachableRows(rows, INDEX);
  assert.equal(kept.length, 1);
  assert.ok(kept.length < 2, 'one page cannot cannibalize itself');
});

test('the banner distinguishes "checked and clean" from "not checked"', () => {
  // Same rule as hold.disarmed and efficiencyBanner: a check that quietly
  // stopped checking must not render like a clean run.
  assert.match(reachabilityBanner({ index: null, dropped: [] }), /NOT checked/);
  assert.match(reachabilityBanner({ index: INDEX, dropped: [] }), /every candidate URL is live/);
  const noisy = reachabilityBanner({
    index: INDEX,
    dropped: [{ page: u('best-sls-free-toothpaste-2025'), reason: 'redirected', impressions: 949, queries: 2 }],
  });
  assert.match(noisy, /dropped 1 unreachable/);
  assert.match(noisy, /949 impression/);
});

test('the resolver filters BEFORE it detects, not after triage', () => {
  // Filtering after the model has chosen a winner pays for the call and throws
  // it away; filtering the rows means an unreachable URL is never offered.
  const src = readFileSync(join(ROOT, 'agents/cannibalization-resolver/index.js'), 'utf8');
  // Match the CALL SITES, not the function definitions — `function
  // detectCannibalization(queryPageRows)` is declared far above main() and an
  // indexOf on the bare name finds the declaration, which proves nothing.
  const filterAt = src.indexOf('filterReachableRows(rawQueryPageRows');
  const detectAt = src.indexOf('= detectCannibalization(queryPageRows)');
  const extendedAt = src.indexOf('= detectCannibalizationExtended(queryPageRows)');
  assert.ok(filterAt > 0, 'the filter call site must exist');
  assert.ok(detectAt > 0 && extendedAt > 0, 'both detector call sites must exist');
  assert.ok(filterAt < detectAt, 'reachability must be filtered before blog detection');
  assert.ok(filterAt < extendedAt, 'and before extended detection');
  // Both detectors must consume the FILTERED rows, never the raw ones.
  assert.doesNotMatch(src, /detectCannibalization(Extended)?\(rawQueryPageRows\)/,
    'a detector reading rawQueryPageRows bypasses the filter entirely');
  assert.match(src, /reachabilityBanner\(/, 'the run must say what it filtered');
});
