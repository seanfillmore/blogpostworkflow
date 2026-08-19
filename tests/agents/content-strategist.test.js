import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagCalendarItems, buildValidatedDemandSection } from '../../agents/content-strategist/index.js';

const idx = {
  keywords: {
    'natural-deodorant':     { slug: 'natural-deodorant',     keyword: 'natural deodorant',     validation_source: 'amazon' },
    'best-soap-for-tattoos': { slug: 'best-soap-for-tattoos', keyword: 'best soap for tattoos', validation_source: 'gsc_ga4' },
  },
};

test('tagCalendarItems stamps validation_source by keyword lookup', () => {
  const items = [
    { slug: 'natural-deodorant', keyword: 'natural deodorant' },
    { slug: 'best-soap-for-tattoos', keyword: 'best soap for tattoos' },
    { slug: 'unmapped', keyword: 'never seen before' },
  ];
  const out = tagCalendarItems(items, idx);
  assert.equal(out[0].validation_source, 'amazon');
  assert.equal(out[1].validation_source, 'gsc_ga4');
  assert.equal(out[2].validation_source, null);
});

test('tagCalendarItems handles null index', () => {
  const items = [{ keyword: 'x' }];
  const out = tagCalendarItems(items, null);
  assert.equal(out[0].validation_source, null);
});

test('buildValidatedDemandSection returns empty string when no entries', () => {
  assert.equal(buildValidatedDemandSection([]), '');
  assert.equal(buildValidatedDemandSection(null), '');
});

test('buildValidatedDemandSection groups amazon and gsc_ga4 entries', () => {
  const out = buildValidatedDemandSection([
    { keyword: 'a', validation_source: 'amazon', amazon: { purchases: 10 } },
    { keyword: 'b', validation_source: 'gsc_ga4', ga4: { conversions: 3 } },
  ]);
  assert.ok(out.includes('Amazon-validated:'));
  assert.ok(out.includes('GSC+GA4-validated:'));
  assert.ok(out.includes('"a"'));
  assert.ok(out.includes('"b"'));
});

import { briefQueueToCalendarItems } from '../../agents/content-strategist/index.js';

test('briefQueueToCalendarItems assigns sequential weeks (2 posts/week, Mon then Thu)', () => {
  const queue = [
    { keyword: 'a', title: 'A', category: 'cat' },
    { keyword: 'b', title: 'B', category: 'cat' },
    { keyword: 'c', title: 'C', category: 'cat' },
    { keyword: 'd', title: 'D', category: 'cat' },
  ];
  // Pin "today" to a known weekday (Sunday Apr 27 2025 UTC)
  const items = briefQueueToCalendarItems(queue, null, new Date('2025-04-27T00:00:00Z'));
  assert.equal(items[0].week, 1);
  assert.equal(items[1].week, 1);
  assert.equal(items[2].week, 2);
  assert.equal(items[3].week, 2);

  // First publish should be next Monday (Apr 28). Second is the same week's Thu (May 1).
  const d0 = new Date(items[0].publish_date);
  const d1 = new Date(items[1].publish_date);
  assert.equal(d0.getUTCDay(), 1, 'first item should publish on Monday');
  assert.equal(d1.getUTCDay(), 4, 'second item should publish on Thursday');
  assert.equal((d1 - d0) / (24 * 3600 * 1000), 3, '3-day gap Mon→Thu');
});

test('briefQueueToCalendarItems stamps validation_source via keyword-index', () => {
  const queue = [{ keyword: 'natural deodorant', title: 'X' }];
  const idx = { keywords: { 'natural-deodorant': { slug: 'natural-deodorant', keyword: 'natural deodorant', validation_source: 'amazon' } } };
  const items = briefQueueToCalendarItems(queue, idx, new Date('2025-04-27T00:00:00Z'));
  assert.equal(items[0].validation_source, 'amazon');
  assert.equal(items[0].priority, 'high');
});

test('briefQueueToCalendarItems uses normal priority when not Amazon-validated', () => {
  const queue = [{ keyword: 'no entry', title: 'X' }];
  const items = briefQueueToCalendarItems(queue, null, new Date('2025-04-27T00:00:00Z'));
  assert.equal(items[0].validation_source, null);
  assert.equal(items[0].priority, 'normal');
});

test('briefQueueToCalendarItems sets source to content_strategist', () => {
  const items = briefQueueToCalendarItems([{ keyword: 'a', title: 'A' }], null, new Date('2025-04-27T00:00:00Z'));
  assert.equal(items[0].source, 'content_strategist');
});

test('briefQueueToCalendarItems handles empty queue', () => {
  const items = briefQueueToCalendarItems([], null);
  assert.deepEqual(items, []);
});

// ── date-drift guard ──────────────────────────────────────────────────────────
// The strategist re-plans on every run and used to re-date every item from
// "next Monday", so an item that stayed at queue position 0 slid forward one
// week per week and never arrived. Combined with calendar-runner's 7-day lead
// window that stalled the writer for 12 days (2026-08-06 → 2026-08-18).
// An item already on the calendar must keep its date.

// 2026-08-17 is a Monday, so the next free slot is Monday 2026-08-24.
const MONDAY = new Date('2026-08-17T00:00:00Z');

test('briefQueueToCalendarItems keeps the date of an item already on the calendar', () => {
  const existing = [{ slug: 'a', keyword: 'a', publish_date: '2026-08-10T15:00:00.000Z' }];
  const items = briefQueueToCalendarItems([{ keyword: 'a', title: 'A' }], null, MONDAY, existing);
  assert.equal(items[0].publish_date, '2026-08-10T15:00:00.000Z');
});

test('briefQueueToCalendarItems does not re-date a far-future item either', () => {
  const existing = [{ slug: 'a', keyword: 'a', publish_date: '2026-10-01T15:00:00.000Z' }];
  const items = briefQueueToCalendarItems([{ keyword: 'a', title: 'A' }], null, MONDAY, existing);
  assert.equal(items[0].publish_date, '2026-10-01T15:00:00.000Z');
});

test('briefQueueToCalendarItems gives a brand-new item the next free slot', () => {
  const items = briefQueueToCalendarItems([{ keyword: 'new', title: 'N' }], null, MONDAY, []);
  assert.equal(items[0].publish_date, '2026-08-24T15:00:00.000Z');
});

test('briefQueueToCalendarItems does not put a new item on a date an existing item holds', () => {
  const existing = [{ slug: 'held', keyword: 'held', publish_date: '2026-08-24T15:00:00.000Z' }];
  const queue = [{ keyword: 'new', title: 'N' }, { keyword: 'held', title: 'H' }];
  const items = briefQueueToCalendarItems(queue, null, MONDAY, existing);
  const dates = items.map((i) => i.publish_date);
  assert.equal(new Set(dates).size, 2, 'every item needs its own publish date');
  assert.equal(items[1].publish_date, '2026-08-24T15:00:00.000Z', 'existing item keeps its slot');
  assert.equal(items[0].publish_date, '2026-08-27T15:00:00.000Z', 'new item takes the next free slot');
});

test('briefQueueToCalendarItems derives week from the final date, not queue position', () => {
  const existing = [{ slug: 'a', keyword: 'a', publish_date: '2026-09-07T15:00:00.000Z' }];
  const items = briefQueueToCalendarItems([{ keyword: 'a', title: 'A' }], null, MONDAY, existing);
  // Aug 24 is week 1, so Sep 7 is week 3.
  assert.equal(items[0].week, 3);
});

test('briefQueueToCalendarItems clamps an overdue item to week 1', () => {
  const existing = [{ slug: 'a', keyword: 'a', publish_date: '2026-07-01T15:00:00.000Z' }];
  const items = briefQueueToCalendarItems([{ keyword: 'a', title: 'A' }], null, MONDAY, existing);
  assert.equal(items[0].week, 1);
});

// ── duplicate keywords ────────────────────────────────────────────────────────
// The semantic dedupe explicitly let EXACT matches through, so keywords with a
// live post ("natural antiperspirant") were re-scheduled. The exemption exists
// because the candidate list includes the calendar's own items — an item must
// not match itself — but it must not extend to published posts.

import { findScheduledDuplicate } from '../../agents/content-strategist/index.js';

test('findScheduledDuplicate blocks a keyword that exactly matches a published post', () => {
  const dup = findScheduledDuplicate('natural antiperspirant', {
    publishedKeywords: ['natural antiperspirant'],
  });
  assert.equal(dup, 'natural antiperspirant');
});

test('findScheduledDuplicate ignores case when matching a published post', () => {
  const dup = findScheduledDuplicate('sls sensitivity toothpaste', {
    publishedKeywords: ['SLS sensitivity toothpaste'],
  });
  assert.equal(dup, 'SLS sensitivity toothpaste');
});

test('findScheduledDuplicate blocks a near-duplicate of a published post', () => {
  const dup = findScheduledDuplicate('toothpaste without sls', {
    publishedKeywords: ['sls free toothpaste'],
  });
  assert.equal(dup, 'sls free toothpaste');
});

test('findScheduledDuplicate lets a calendar item match itself', () => {
  const dup = findScheduledDuplicate('vegan soap', { calendarKeywords: ['vegan soap'] });
  assert.equal(dup, null);
});

test('findScheduledDuplicate still blocks a near-duplicate of another calendar item', () => {
  const dup = findScheduledDuplicate('toothpaste without sls', {
    calendarKeywords: ['sls free toothpaste'],
  });
  assert.equal(dup, 'sls free toothpaste');
});

test('findScheduledDuplicate returns null when nothing matches', () => {
  const dup = findScheduledDuplicate('oatmeal soap', {
    publishedKeywords: ['natural antiperspirant'],
    calendarKeywords: ['vegan soap'],
  });
  assert.equal(dup, null);
});

test('findScheduledDuplicate keeps a deliberate audience split', () => {
  // cannibalization-guard treats "for men" as a separate segment, not a duplicate.
  const dup = findScheduledDuplicate('aluminum free deodorant for men', {
    publishedKeywords: ['aluminum free deodorant for women'],
  });
  assert.equal(dup, null);
});

// ── review items survive a re-plan ────────────────────────────────────────────
// content-strategist replaces the whole calendar with its brief queue. Items in
// `review` (promoted by gsc-opportunity, awaiting approval in the dashboard
// Ideas inbox) are not in that queue, so they survived only when the LLM
// happened to re-emit the same keyword.

import { mergeReviewItems } from '../../agents/content-strategist/index.js';

test('mergeReviewItems carries a review item the brief queue dropped', () => {
  const merged = mergeReviewItems(
    [{ slug: 'a', keyword: 'a' }],
    [{ slug: 'idea', keyword: 'idea', status: 'review' }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[1].slug, 'idea');
  assert.equal(merged[1].status, 'review');
});

test('mergeReviewItems does not duplicate a review item the queue re-emitted', () => {
  const merged = mergeReviewItems(
    [{ slug: 'idea', keyword: 'idea' }],
    [{ slug: 'idea', keyword: 'idea', status: 'review' }],
  );
  assert.equal(merged.length, 1);
});

test('mergeReviewItems leaves non-review items behind', () => {
  const merged = mergeReviewItems(
    [{ slug: 'a', keyword: 'a' }],
    [{ slug: 'stale', keyword: 'stale', status: null }],
  );
  assert.deepEqual(merged.map((i) => i.slug), ['a']);
});

// ── pre-paid briefs surfaced to the planner ───────────────────────────────────

import { buildPrepaidSection, buildNonEarningSection } from '../../agents/content-strategist/index.js';

test('buildPrepaidSection tells the planner to schedule briefed work first', () => {
  const out = buildPrepaidSection(['vegan-soap', 'oatmeal-soap']);
  assert.match(out, /vegan-soap/);
  assert.match(out, /SCHEDULE THESE FIRST/);
});

test('buildPrepaidSection is empty when there is no pre-paid work', () => {
  assert.equal(buildPrepaidSection([]), '');
  assert.equal(buildPrepaidSection(null), '');
});

test('buildPrepaidSection caps the list so an 8-week plan is not swamped', () => {
  const many = Array.from({ length: 40 }, (_, i) => `topic-${i}`);
  const out = buildPrepaidSection(many, 5);
  assert.match(out, /topic-0/);
  assert.ok(!out.includes('topic-9'), 'past the cap is not listed');
  assert.match(out, /\+35 more/);
});

// ── clusters that do not earn ─────────────────────────────────────────────────

import { classifyClusters } from '../../lib/cluster-revenue.js';

const CLUSTERS = classifyClusters([
  { cluster: 'body lotion', revenue: 87.09, clicks: 34,  pages: 20 },
  { cluster: 'toothpaste',  revenue: 0,     clicks: 725, pages: 26 },
  { cluster: 'hand soap',   revenue: 0,     clicks: 1,   pages: 2  },
]);

test('buildNonEarningSection forbids new posts in a cluster with traffic and no revenue', () => {
  const out = buildNonEarningSection(CLUSTERS);
  assert.match(out, /toothpaste/i);
  assert.match(out, /DO NOT propose/i);
  assert.match(out, /725 clicks/);
});

test('buildNonEarningSection does not condemn an untested cluster', () => {
  const out = buildNonEarningSection(CLUSTERS);
  assert.ok(!/hand soap/i.test(out), 'one click is not evidence — it would never get tested');
});

test('buildNonEarningSection is empty when every cluster earns or is untested', () => {
  const out = buildNonEarningSection(classifyClusters([
    { cluster: 'body lotion', revenue: 87.09, clicks: 34, pages: 20 },
  ]));
  assert.equal(out, '');
});
