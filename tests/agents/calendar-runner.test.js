import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatPublishAt } from '../../agents/calendar-runner/index.js';

test('snaps Tuesday to Wednesday', () => {
  // 2026-03-31 is a Tuesday
  const result = formatPublishAt(new Date('2026-03-31T12:00:00Z'));
  assert.match(result, /^2026-04-01T08:00:00-07:00$/);
});

test('snaps Saturday to Monday', () => {
  // 2026-04-04 is a Saturday
  const result = formatPublishAt(new Date('2026-04-04T12:00:00Z'));
  assert.match(result, /^2026-04-06T08:00:00-07:00$/);
});

test('keeps Monday as Monday', () => {
  // 2026-03-30 is a Monday — already a publish day
  const result = formatPublishAt(new Date('2026-03-30T12:00:00Z'));
  assert.match(result, /^2026-03-30T08:00:00-07:00$/);
});

test('keeps Wednesday as Wednesday', () => {
  // 2026-04-01 is a Wednesday
  const result = formatPublishAt(new Date('2026-04-01T12:00:00Z'));
  assert.match(result, /^2026-04-01T08:00:00-07:00$/);
});

test('keeps Friday as Friday', () => {
  // 2026-04-03 is a Friday
  const result = formatPublishAt(new Date('2026-04-03T12:00:00Z'));
  assert.match(result, /^2026-04-03T08:00:00-07:00$/);
});

test('snaps Sunday to Monday', () => {
  // 2026-04-05 is a Sunday
  const result = formatPublishAt(new Date('2026-04-05T12:00:00Z'));
  assert.match(result, /^2026-04-06T08:00:00-07:00$/);
});

test('past date advances to future Mon/Wed/Fri', () => {
  // 2020-01-01 is far in the past — result must be a future Mon/Wed/Fri
  const result = formatPublishAt(new Date('2020-01-01T12:00:00Z'));
  const d = new Date(result);
  const day = d.getDay();
  assert.ok([1, 3, 5].includes(day), `Expected Mon/Wed/Fri, got day ${day}`);
  assert.ok(d > new Date(), 'Result must be in the future');
});
