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
import { WIDE_ORDERS } from '../helpers/cluster-fixtures.js';

// Priority is keyed on what the category SOLD over the 90-day judging window,
// from raw order line items — not on what landed on pages named after it. The
// $0 rows below are SYNTHETIC: on the real 2026-08-23 report every category RSC
// sells, sells, so a dud fixture is the only way to exercise the deferral.
const CLASSIFIED = classifyClusters([
  { cluster: 'body lotion', revenue: 87.09, clicks: 34,  pages: 20 },
  { cluster: 'toothpaste',  revenue: 0,     clicks: 725, pages: 26 },
  { cluster: 'hand soap',   revenue: 0,     clicks: 1,   pages: 2  },
], { productRevenue: { lotion: 1757.1, toothpaste: 0, soap: 0 }, windowOrders: WIDE_ORDERS });

test('revenueAdjustment accelerates a cluster that earns', () => {
  const adj = revenueAdjustment('Body Lotion', CLASSIFIED);
  assert.ok(adj.days < 0, 'earning clusters move earlier');
  assert.match(adj.reason, /sold \$1757\.10/, 'the reason states what the category SOLD, not what its pages earned');
});

test('revenueAdjustment defers a cluster with traffic and no revenue', () => {
  const adj = revenueAdjustment('Toothpaste', CLASSIFIED);
  assert.ok(adj.days > 0, 'a proven dud moves later, behind work that earns');
  assert.match(adj.reason, /725 clicks/);
  assert.match(adj.reason, /sold \$0\.00/);
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

// ── runner and brief triage must bucket a topic the same way ─────────────────
// The runner looked the calendar item's `category` up directly; the brief triage
// ran clusterForText() over the KEYWORD. seo-impact carries 'bar soap' and 'soap'
// as separate clusters with different verdicts, so "oatmeal soap" had its brief
// deleted as soap ($0, 180 clicks) while its calendar item sailed through
// labelled "Bar Soap" (unproven). Same topic, two answers, depending on which
// field happened to be read.

// SYNTHETIC product revenue: the real soap cluster sold $324.85 over the judging
// window and is not a dud at all. What is under test here is that the runner and
// the brief triage bucket the same TOPIC identically, so the fixture gives soap
// a $0 product reading to produce a verdict either could act on.
const SOAP = classifyClusters([
  { cluster: 'soap',      revenue: 0, clicks: 470, pages: 20 },
  { cluster: 'bar soap',  revenue: 0, clicks: 10,  pages: 4  },
  { cluster: 'deodorant', revenue: 17.26, clicks: 109, pages: 21 },
], { productRevenue: { soap: 0, deodorant: 165 }, windowOrders: WIDE_ORDERS });

test('revenueAdjustment judges on the keyword, matching what the brief triage does', () => {
  const adj = revenueAdjustment('Bar Soap', SOAP, 'oatmeal soap');
  assert.ok(adj.days > 0, 'clusterForText("oatmeal soap") is soap — a dud — whatever the LLM labelled it');
  assert.match(adj.reason, /soap/);
});

test('revenueAdjustment folds a bar-soap topic into the soap verdict', () => {
  // 'bar soap' was merged into 'soap' on 2026-08-18 — keeping them apart split
  // one category's evidence and let bar-soap-labelled work escape the dud rule.
  const adj = revenueAdjustment('Bar Soap', SOAP, 'organic bar soap');
  assert.ok(adj.days > 0);
  assert.match(adj.reason, /soap/);
});

test('revenueAdjustment falls back to the category when there is no keyword', () => {
  const adj = revenueAdjustment('Deodorant', SOAP, null);
  assert.ok(adj.days < 0);
});

// ── a cluster we have decided not to add to is not "later", it is "no" ────────
// Deferring a proven dud only moved it down the calendar — the post still got
// written, just in October. "We have an abundance of soap content so no need to
// produce more" means it must not be drafted at all.

test('selectWorkItems will not draft an item in a cluster that has proven it does not earn', () => {
  const items = [pending('oatmeal soap', '2026-08-20T15:00:00Z')];
  const { workItems, blocked } = selectWorkItems(items, {
    now: NOW, bufferDays: 7, statusOf: () => 'briefed', clusterRevenue: SOAP,
  });
  assert.equal(workItems.length, 0, 'in-window is not enough — the cluster is closed');
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].blockedReason, /soap/);
});

test('selectWorkItems does not count a blocked item as a stall backlog', () => {
  const items = [pending('oatmeal soap', '2026-08-20T15:00:00Z')];
  const { deferred, blocked } = selectWorkItems(items, {
    now: NOW, bufferDays: 7, statusOf: () => 'briefed', clusterRevenue: SOAP,
  });
  assert.equal(deferred.length, 0, 'work we have decided not to do is not work waiting');
  assert.equal(blocked.length, 1);
});

test('selectWorkItems still drafts an earning cluster normally', () => {
  const items = [pending('chlorophyll deodorant', '2026-08-20T15:00:00Z')];
  const { workItems, blocked } = selectWorkItems(items, {
    now: NOW, bufferDays: 7, statusOf: () => 'briefed', clusterRevenue: SOAP,
  });
  assert.equal(workItems.length, 1);
  assert.equal(blocked.length, 0);
});

test('selectWorkItems blocks nothing when no revenue data is supplied', () => {
  const items = [pending('oatmeal soap', '2026-08-20T15:00:00Z')];
  const { workItems, blocked } = selectWorkItems(items, {
    now: NOW, bufferDays: 7, statusOf: () => 'briefed',
  });
  assert.equal(workItems.length, 1, 'absent data is not evidence of $0');
  assert.equal(blocked.length, 0);
});

test('an explicit --keyword run still overrides the cluster block', () => {
  const items = [pending('oatmeal soap', '2026-08-20T15:00:00Z')];
  const { workItems } = selectWorkItems(items, {
    now: NOW, bufferDays: 7, keyword: 'oatmeal soap', statusOf: () => 'briefed', clusterRevenue: SOAP,
  });
  assert.equal(workItems.length, 1, 'naming an item by hand is a deliberate override');
});
