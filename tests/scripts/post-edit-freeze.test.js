import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUntil, MAX_FREEZE_DAYS } from '../../scripts/post-edit-freeze.mjs';

const NOW = new Date('2026-10-03T12:00:00Z');
test('a freeze must expire, and within the cap', () => {
  assert.equal(validateUntil('2026-11-14', NOW), '2026-11-14T00:00:00.000Z');
  assert.throws(() => validateUntil('2026-10-01', NOW), /future/);
  assert.throws(() => validateUntil('2027-06-01', NOW), new RegExp(String(MAX_FREEZE_DAYS)));
  assert.throws(() => validateUntil(null, NOW), /YYYY-MM-DD/);
});
