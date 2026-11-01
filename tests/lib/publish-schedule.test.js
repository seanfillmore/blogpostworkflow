import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatPublishAt, nextOpenSlot, PUBLISH_DAYS, slotsFrom } from '../../lib/publish-schedule.js';

const NOW = new Date('2026-06-15T12:00:00-07:00'); // a Monday

test('formatPublishAt snaps to a Mon/Tue/Thu/Fri slot at 08:00 PT', () => {
  const out = formatPublishAt(new Date('2026-06-17T00:00:00-07:00'), NOW); // Wed -> Thu
  assert.equal(out, '2026-06-18T08:00:00-07:00');
});

test('PUBLISH_DAYS is four days a week, never two in one day', () => {
  assert.deepEqual([...PUBLISH_DAYS], [1, 2, 4, 5]);
});

test('slotsFrom walks publish days in order, skipping taken dates', () => {
  const next = slotsFrom(new Date('2026-06-15T00:00:00Z'), new Set(['2026-06-16']));
  const got = [next(), next(), next()].map((d) => d.toISOString());
  assert.deepEqual(got, ['2026-06-15T15:00:00.000Z', '2026-06-18T15:00:00.000Z', '2026-06-19T15:00:00.000Z']);
});

test('formatPublishAt advances past now', () => {
  const out = formatPublishAt(new Date('2026-06-01T00:00:00-07:00'), NOW); // past -> future
  assert.equal(new Date(out) > NOW, true);
});

test('nextOpenSlot skips dates already taken', () => {
  const taken = new Set(['2026-06-16']); // Tue taken
  const out = nextOpenSlot(taken, new Date('2026-06-16T00:00:00-07:00'), NOW); // Tue taken -> Thu
  assert.equal(out, '2026-06-18T08:00:00-07:00');
});

test('nextOpenSlot returns first free slot when nothing taken', () => {
  const out = nextOpenSlot(new Set(), new Date('2026-06-16T00:00:00-07:00'), NOW);
  assert.equal(out, '2026-06-16T08:00:00-07:00');
});
