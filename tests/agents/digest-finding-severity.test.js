import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../lib/posts.js';

// `status: 'error'` changes only how the digest RENDERS a row — it has never
// escalated to an email. What it does control is the "Failures" block, which is
// the one part of the 5 AM digest a human is meant to read as "something broke".
//
// Five agents put a routine FINDING in that block on every run. Across the 14
// digests to 2026-08-29, four of them fired on all 14 days, so roughly half of
// every day's failure count was reports whose agent had completed successfully —
// on 2026-08-28 that was 8 of 15. A Failures block that is half noise is one
// nobody reads, which is how a genuine daily `Legacy Rebuilder failed` went
// unread before (see ERROR_ROWS_SHOWN in agents/daily-summary).
//
// A source scan rather than a behavioural test because these notify() calls sit
// inside each agent's main(), and importing an agent runs it.

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('indexing coverage is a finding, not a failure', () => {
  const src = read('agents/indexing-checker/index.js');
  assert.match(src, /subject: `Indexing: \$\{critical\.length\} critical/);
  assert.doesNotMatch(src, /critical\.length > 0 \? 'error'/);
});

test('a PageSpeed regression is a lab measurement, not a failure', () => {
  const src = read('agents/pagespeed-monitor/index.js');
  // The fetch-failure path keeps 'error'; the measurement path must not.
  assert.match(src, /'PageSpeed Monitor failed'[\s\S]{0,120}status: 'error'/);
  assert.doesNotMatch(src, /vitalRegressions \? 'error'/);
});

test('a post-performance flop is a verdict, not a failure', () => {
  const src = read('agents/post-performance/index.js');
  assert.doesNotMatch(src, /flopsToday\.length \? 'error'/);
});

test('"no relevant product" is a scope decision, not a failure', () => {
  const src = read('agents/featured-product-injector/index.js');
  assert.doesNotMatch(src, /'no relevant product' \? 'error'/);
});

test('RUM keeps error for NO BEACONS — that one is a real outage', () => {
  const src = read('agents/rum-monitor/index.js');
  // The split is the point: an empty beacon stream means the storefront stopped
  // reporting and nothing else in the fleet would say so. Poor vitals on one
  // page/device pair is a reading.
  assert.match(src, /!beacons\.length \? 'error'/, 'no beacons must still raise a failure');
  assert.doesNotMatch(src, /failing\.length \|\| !beacons\.length \? 'error'/);
});
