import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, applyEdits, checkNewCopy } from '../../scripts/flows/align-offers-2026-10-05.mjs';

test('new copy has no em dash and never mentions subscriptions', () => {
  assert.doesNotThrow(() => checkNewCopy(PLAN));
});

test('the welcome emails name the same 30% offer as the popup', () => {
  for (const name of ['Welcome 1', 'Welcome 5']) {
    const e = PLAN.find((p) => p.name === name);
    assert.ok(e.edits.some(([, after]) => after === 'WELCOME30'), name);
    assert.match(e.subject[1], /30% off/);
  }
});

test('applyEdits is idempotent and refuses an unexpected count', () => {
  const edits = [['SHIPFREE', 'WELCOME30', 1]];
  const once = applyEdits('<p>SHIPFREE</p>', edits);
  assert.equal(once.html, '<p>WELCOME30</p>');
  const twice = applyEdits(once.html, edits);
  assert.equal(twice.changed, false);
  assert.throws(() => applyEdits('<p>SHIPFREE SHIPFREE</p>', edits));
  assert.throws(() => applyEdits('<p>nothing</p>', edits));
});

test('replenishment pack claims match the live ladders', () => {
  // cream 5-pack $112 = 4 x $28; bar soap 12-pack $88 = 8 x $11
  const box = PLAN.find((p) => p.name === 'Replenishment 1').edits.map(([, a]) => a);
  assert.ok(box.includes('Buy 4, get 1 free') && box.includes('Buy 8, get 4 free'));
});
