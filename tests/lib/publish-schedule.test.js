import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatPublishAt, nextOpenSlot } from '../../lib/publish-schedule.js';

const NOW = new Date('2026-06-15T12:00:00-07:00'); // a Monday

test('formatPublishAt snaps to a Mon/Wed/Fri slot at 08:00 PT', () => {
  const out = formatPublishAt(new Date('2026-06-16T00:00:00-07:00'), NOW); // Tue -> Wed
  assert.equal(out, '2026-06-17T08:00:00-07:00');
});

test('formatPublishAt advances past now', () => {
  const out = formatPublishAt(new Date('2026-06-01T00:00:00-07:00'), NOW); // past -> future
  assert.equal(new Date(out) > NOW, true);
});

test('nextOpenSlot skips dates already taken', () => {
  const taken = new Set(['2026-06-17']); // Wed taken
  const out = nextOpenSlot(taken, new Date('2026-06-16T00:00:00-07:00'), NOW); // Tue -> Wed taken -> Fri
  assert.equal(out, '2026-06-19T08:00:00-07:00');
});

test('nextOpenSlot returns first free slot when nothing taken', () => {
  const out = nextOpenSlot(new Set(), new Date('2026-06-16T00:00:00-07:00'), NOW);
  assert.equal(out, '2026-06-17T08:00:00-07:00');
});
