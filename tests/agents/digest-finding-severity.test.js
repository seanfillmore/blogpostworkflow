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

test('a flagged ad campaign is a finding, not a failure', () => {
  // Added 2026-09-01 alongside the lifetime gate in agents/shopping-test-monitor. Until
  // that landed the flags could essentially never fire (the 150-click floor is never
  // reached inside one 14-day window at ~$7.75/day), so this mislabelling had never been
  // seen. Making the gate work would have started posting two routine rows into the
  // Failures block every morning.
  const src = read('agents/shopping-test-monitor/index.js');
  assert.doesNotMatch(src, /flags\.length \? 'error'/,
    "a dead-spend verdict is a reading for a human, not a report that the agent broke");
  assert.match(src, /const status = 'info'/);
  assert.match(src, /campaign\(s\) need attention/, 'the subject must still carry the count');
});

// ── Added 2026-09-08 ────────────────────────────────────────────────────────
// Three more agents shared ONE shape: `status: failed.length ? 'error' : …`, so a
// single bad item flipped a run that had otherwise SUCCEEDED into the Failures
// block. The 2026-09-07 digest is the evidence — 7 failure rows, of which
// "Blocked Post Resolver: 3 resolved, 0 written off, 1 failed" and
// "Queue auto-apply: 1 applied, 0 dismissed" are both agents doing their job.
//
// The rule these restore is the one at the top of this file: `error` means a
// human should go fix the AGENT. A per-item failure is a finding, named in the
// body, that a human should READ. Genuine breakage in all three is the catch in
// main(), which still sets 'error' and is asserted here so demoting the summary
// row cannot silently demote the crash handler with it.

test('a blocked-post-resolver item failure is a finding, not a failure', () => {
  const src = read('agents/blocked-post-resolver/index.js');
  assert.doesNotMatch(src, /status: failed\.length \? 'error'/,
    '3 resolved and 1 failed is a working run, not a broken agent');
  assert.match(src, /'Blocked Post Resolver failed'[\s\S]{0,160}status: 'error'/,
    'the crash handler must keep error');
});

test('a queue-autoapply item failure is a finding, not a failure', () => {
  const src = read('agents/queue-autoapply/index.js');
  assert.doesNotMatch(src, /status: failed\.length \? 'error'/,
    '1 applied and 1 failed is a working run');
});

test('a refresh-runner publish refusal is a finding, not a failure', () => {
  const src = read('agents/refresh-runner/index.js');
  // A refusal here is usually a GATE working — a divergent content mirror, or a
  // failing editor gate. Reporting the publisher's correct refusal as a broken
  // agent is precisely backwards.
  assert.doesNotMatch(src, /status: failed\.length \? 'error'/);
});
