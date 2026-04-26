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
