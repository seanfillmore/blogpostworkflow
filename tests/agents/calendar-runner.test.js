import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatPublishAt } from '../../agents/calendar-runner/index.js';

// All snap-day tests anchor `now` BEFORE the input date, so the
// past-date-advancement loop never fires and we test only the
// day-of-week snapping behavior.
const NOW_BEFORE_INPUTS = new Date('2026-03-29T00:00:00Z');

test('snaps Tuesday to Wednesday', () => {
  // 2026-03-31 is a Tuesday
  const result = formatPublishAt(new Date('2026-03-31T12:00:00Z'), NOW_BEFORE_INPUTS);
  assert.match(result, /^2026-04-01T08:00:00-07:00$/);
});

test('snaps Saturday to Monday', () => {
  // 2026-04-04 is a Saturday
  const result = formatPublishAt(new Date('2026-04-04T12:00:00Z'), NOW_BEFORE_INPUTS);
  assert.match(result, /^2026-04-06T08:00:00-07:00$/);
});

test('keeps Monday as Monday', () => {
  // 2026-03-30 is a Monday — already a publish day
  const result = formatPublishAt(new Date('2026-03-30T12:00:00Z'), NOW_BEFORE_INPUTS);
  assert.match(result, /^2026-03-30T08:00:00-07:00$/);
});

test('keeps Wednesday as Wednesday', () => {
  // 2026-04-01 is a Wednesday
  const result = formatPublishAt(new Date('2026-04-01T12:00:00Z'), NOW_BEFORE_INPUTS);
  assert.match(result, /^2026-04-01T08:00:00-07:00$/);
});

test('keeps Friday as Friday', () => {
  // 2026-04-03 is a Friday
  const result = formatPublishAt(new Date('2026-04-03T12:00:00Z'), NOW_BEFORE_INPUTS);
  assert.match(result, /^2026-04-03T08:00:00-07:00$/);
});

test('snaps Sunday to Monday', () => {
  // 2026-04-05 is a Sunday
  const result = formatPublishAt(new Date('2026-04-05T12:00:00Z'), NOW_BEFORE_INPUTS);
  assert.match(result, /^2026-04-06T08:00:00-07:00$/);
});

test('past date advances to future Mon/Wed/Fri', () => {
  // 2020-01-01 is far in the past relative to a fixed 2026-04-01 anchor.
  const fixedNow = new Date('2026-04-01T00:00:00Z');
  const result = formatPublishAt(new Date('2020-01-01T12:00:00Z'), fixedNow);
  const d = new Date(result);
  const day = d.getDay();
  assert.ok([1, 3, 5].includes(day), `Expected Mon/Wed/Fri, got day ${day}`);
  assert.ok(d >= fixedNow, 'Result must not be before the anchor');
});

// ── lead-window reporting ─────────────────────────────────────────────────────
// The runner drafts only items whose publish date is inside the BUFFER_DAYS lead
// window, but reported an empty selection as "All calendar items are published or
// scheduled. Nothing to do." — indistinguishable from a genuinely empty calendar.
// That message hid a 12-day stall (last post written 2026-08-06) behind a daily
// "✓ calendar-runner --run complete" in the scheduler log.

import { selectWorkItems } from '../../agents/calendar-runner/index.js';

const NOW = new Date('2026-08-18T00:00:00Z');
const pending = (keyword, iso) => ({ keyword, slug: keyword, publishDate: new Date(iso) });

test('selectWorkItems returns items inside the lead window', () => {
  const items = [pending('a', '2026-08-20T15:00:00Z')];
  const { workItems, deferred } = selectWorkItems(items, {
    now: NOW, bufferDays: 7, statusOf: () => 'briefed',
  });
  assert.equal(workItems.length, 1);
  assert.equal(deferred.length, 0);
});

test('selectWorkItems reports out-of-window items as deferred, not as nothing', () => {
  const items = [pending('a', '2026-09-03T15:00:00Z')];
  const { workItems, deferred } = selectWorkItems(items, {
    now: NOW, bufferDays: 7, statusOf: () => 'briefed',
  });
  assert.equal(workItems.length, 0);
  assert.equal(deferred.length, 1, 'a pending item outside the window is deferred, not absent');
  assert.equal(deferred[0].keyword, 'a');
});

test('selectWorkItems excludes published and scheduled items entirely', () => {
  const items = [pending('done', '2026-08-20T15:00:00Z'), pending('queued', '2026-08-20T15:00:00Z')];
  const statusOf = (i) => (i.keyword === 'done' ? 'published' : 'scheduled');
  const { workItems, deferred } = selectWorkItems(items, { now: NOW, bufferDays: 7, statusOf });
  assert.equal(workItems.length, 0);
  assert.equal(deferred.length, 0, 'finished items are not a backlog');
});

test('selectWorkItems sorts deferred items earliest-first so the report names the true next item', () => {
  const items = [pending('later', '2026-10-01T15:00:00Z'), pending('sooner', '2026-09-03T15:00:00Z')];
  const { deferred } = selectWorkItems(items, { now: NOW, bufferDays: 7, statusOf: () => 'briefed' });
  assert.equal(deferred[0].keyword, 'sooner');
});

test('selectWorkItems ignores the lead window for a keyword-targeted run', () => {
  const items = [pending('faraway', '2026-12-01T15:00:00Z')];
  const { workItems } = selectWorkItems(items, {
    now: NOW, bufferDays: 7, keyword: 'faraway', statusOf: () => 'briefed',
  });
  assert.equal(workItems.length, 1, '--keyword is an explicit override of JIT drafting');
});

test('selectWorkItems prefers an adjusted date over the calendar date', () => {
  const item = { ...pending('a', '2026-09-03T15:00:00Z'), adjustedDate: new Date('2026-08-20T15:00:00Z') };
  const { workItems } = selectWorkItems([item], { now: NOW, bufferDays: 7, statusOf: () => 'briefed' });
  assert.equal(workItems.length, 1);
});

// ── stall detection ───────────────────────────────────────────────────────────
// The 12-day stall was invisible because every daily run printed "✓ complete".
// An honest log line is not enough on its own — nobody reads the scheduler log.
// This is the condition worth an email: unwritten work exists AND nothing has
// been drafted for longer than the calendar's own pacing would ever explain.

import { detectDraftStall } from '../../agents/calendar-runner/index.js';

const NOW2 = new Date('2026-08-18T00:00:00Z');

test('detectDraftStall fires when nothing has been drafted and work is waiting', () => {
  const stall = detectDraftStall({
    lastDraftedAt: new Date('2026-08-06T00:00:00Z'),
    pendingCount: 7, now: NOW2, maxIdleDays: 10,
  });
  assert.equal(stall.stalled, true);
  assert.equal(stall.idleDays, 12);
});

test('detectDraftStall stays quiet while drafting is keeping pace', () => {
  const stall = detectDraftStall({
    lastDraftedAt: new Date('2026-08-15T00:00:00Z'),
    pendingCount: 7, now: NOW2, maxIdleDays: 10,
  });
  assert.equal(stall.stalled, false);
});

test('detectDraftStall stays quiet when there is genuinely nothing to write', () => {
  const stall = detectDraftStall({
    lastDraftedAt: new Date('2026-06-01T00:00:00Z'),
    pendingCount: 0, now: NOW2, maxIdleDays: 10,
  });
  assert.equal(stall.stalled, false, 'an empty calendar is not a stall');
});

test('detectDraftStall treats a never-drafted pipeline with pending work as stalled', () => {
  const stall = detectDraftStall({ lastDraftedAt: null, pendingCount: 3, now: NOW2, maxIdleDays: 10 });
  assert.equal(stall.stalled, true);
  assert.equal(stall.idleDays, null);
});

// ── revenue-keyed prioritisation ──────────────────────────────────────────────
// Acceleration used to key on RANKING: any cluster with a page-1 post was pulled
// forward two days. Under the Prime Directive that is backwards — the toothpaste
// cluster ranks well enough for 725 clicks across 26 pages and has returned $0,
// so rank-keyed priority kept pulling more toothpaste posts forward. Dollars now.

import { revenueAdjustment } from '../../agents/calendar-runner/index.js';
import { classifyClusters } from '../../lib/cluster-revenue.js';

const CLASSIFIED = classifyClusters([
  { cluster: 'body lotion', revenue: 87.09, clicks: 34,  pages: 20 },
  { cluster: 'toothpaste',  revenue: 0,     clicks: 725, pages: 26 },
  { cluster: 'hand soap',   revenue: 0,     clicks: 1,   pages: 2  },
]);

test('revenueAdjustment accelerates a cluster that earns', () => {
  const adj = revenueAdjustment('Body Lotion', CLASSIFIED);
  assert.ok(adj.days < 0, 'earning clusters move earlier');
  assert.match(adj.reason, /\$87\.09/, 'the reason states the dollars, not the ranking');
});

test('revenueAdjustment defers a cluster with traffic and no revenue', () => {
  const adj = revenueAdjustment('Toothpaste', CLASSIFIED);
  assert.ok(adj.days > 0, 'a proven dud moves later, behind work that earns');
  assert.match(adj.reason, /725 clicks/);
});

test('revenueAdjustment leaves an untested cluster alone', () => {
  const adj = revenueAdjustment('Hand Soap', CLASSIFIED);
  assert.equal(adj.days, 0, 'blocking an untested category means never testing it');
  assert.equal(adj.reason, null);
});

test('revenueAdjustment leaves a cluster absent from the report alone', () => {
  const adj = revenueAdjustment('Brand New Thing', CLASSIFIED);
  assert.equal(adj.days, 0);
});

test('revenueAdjustment never accelerates a dud even when it ranks', () => {
  // The whole point: ranking is not the signal any more.
  const adj = revenueAdjustment('toothpaste', CLASSIFIED);
  assert.ok(adj.days >= 0);
});
