import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropRecoveredFailures, subjectStem } from '../../lib/digest-recovery.js';
import { entrySource } from '../../lib/notify.js';

const row = (ts, status, subject, category = 'creators', source) => ({ ts, status, subject, category, body: '', ...(source ? { source } : {}) });

test('the real 2026-10-03 creator-outreach blips are dropped: each was followed by a successful run', () => {
  const day = [
    row('2026-10-03T04:01:03Z', 'error', 'Creator outreach failed'),
    row('2026-10-03T05:01:03Z', 'error', 'Creator outreach failed'),
    row('2026-10-03T05:30:09Z', 'info', 'Creator outreach: 0 scheduled · 1 replied · 0 escalated'),
    row('2026-10-03T07:31:03Z', 'error', 'Creator outreach failed'),
    row('2026-10-03T14:00:11Z', 'info', 'Creator outreach: 0 scheduled · 1 replied · 0 escalated'),
  ];
  const { kept, recovered } = dropRecoveredFailures(day);
  assert.equal(recovered.length, 3);
  assert.equal(kept.filter((e) => e.status === 'error').length, 0);
  assert.equal(kept.length, 2, 'the successful rows stay');
});

test('a failure with no later successful run stays: it may still be broken', () => {
  const day = [
    row('2026-10-03T10:00:00Z', 'info', 'Creator outreach: 0 scheduled'),
    row('2026-10-03T23:30:00Z', 'error', 'Creator outreach failed'),
  ];
  assert.equal(dropRecoveredFailures(day).kept.filter((e) => e.status === 'error').length, 1);
});

test('a success on the REPORT day (before the email) counts as recovery', () => {
  const day = [row('2026-10-03T23:30:00Z', 'error', 'Meta Ads Collector failed', 'collector')];
  const today = [row('2026-10-04T08:00:00Z', 'success', 'Meta Ads Collector: snapshot saved', 'collector')];
  assert.equal(dropRecoveredFailures(day, today).recovered.length, 1);
});

test('another agent in the same category can never clear a failure', () => {
  const day = [
    row('2026-10-03T04:00:00Z', 'error', 'Trybe review failed', 'creators', 'agents/trybe-review/index.js'),
    row('2026-10-03T05:00:00Z', 'info', 'Trybe review: 3 awaiting', 'creators', 'agents/creator-outreach/index.js'),
    row('2026-10-03T06:00:00Z', 'info', 'Creator outreach: 0 scheduled', 'creators', 'agents/trybe-review/index.js'),
  ];
  assert.equal(dropRecoveredFailures(day).recovered.length, 0);
});

test('a library warning inside an agent is not cleared by that agent\'s ordinary success row', () => {
  const src = 'agents/product-optimizer/index.js';
  const day = [
    row('2026-10-03T04:00:00Z', 'error', 'Shopify API version fell forward', 'ops', src),
    row('2026-10-03T05:00:00Z', 'success', 'Product optimizer: 3 published', 'ops', src),
  ];
  assert.equal(dropRecoveredFailures(day).recovered.length, 0);
});

test('a later error is not recovery', () => {
  const day = [row('2026-10-03T04:00:00Z', 'error', 'Creator outreach failed'), row('2026-10-03T05:00:00Z', 'error', 'Creator outreach failed')];
  assert.equal(dropRecoveredFailures(day).recovered.length, 0);
});

test('subject stems', () => {
  assert.equal(subjectStem('Creator outreach failed'), 'creator outreach');
  assert.equal(subjectStem('Creator outreach: 0 scheduled · 1 replied'), 'creator outreach');
  assert.equal(subjectStem('❌ Meta Ads Collector failed'), 'meta ads collector');
  assert.equal(subjectStem('Post-meta drift gate — exit 0'), 'post-meta drift gate');
});

test('entrySource is repo-relative', () => {
  assert.match(entrySource(new URL('../../agents/creator-outreach/index.js', import.meta.url).pathname), /^agents\/creator-outreach\/index\.js$/);
  assert.equal(entrySource(''), null);
});

import { rowsInWindow, daysBetween } from '../../lib/digest-window.js';

test('the digest window includes the same morning\'s 12:55 Trybe review, and never repeats a row', () => {
  const rows = [
    row('2026-10-03T12:55:00Z', 'info', 'Trybe creators: yesterday'),
    row('2026-10-03T15:00:00Z', 'info', 'Scheduler completed'),
    row('2026-10-04T12:55:00Z', 'info', 'Trybe creators: this morning'),
    row('2026-10-04T13:00:05Z', 'info', 'written after the send'),
  ];
  const w = rowsInWindow(rows, { since: '2026-10-03T13:00:03Z', until: '2026-10-04T13:00:03Z' });
  assert.deepEqual(w.map((r) => r.subject), ['Scheduler completed', 'Trybe creators: this morning']);
});

test('daysBetween spans month ends inclusively', () => {
  assert.deepEqual(daysBetween('2026-09-30', '2026-10-02'), ['2026-09-30', '2026-10-01', '2026-10-02']);
});
