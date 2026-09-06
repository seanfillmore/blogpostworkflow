import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveLine, describe as describeCopy } from '../../scripts/sync-subscription-copy.mjs';

const at = (pct) => ({ pricing_polices: [{ discount: { type: 'percentage', value: pct } }] });

test('the save line comes from the PLAN, never a constant', () => {
  // It was hardcoded at 15%, true of all eight plans the day it was written.
  // Recurpay plan 11152263 (foam refill) runs at 5% deliberately — refills are
  // already discounted — so a constant would write a FALSE discount claim.
  assert.equal(saveLine(at(15)), '<p>✓ Save 15% on every order</p>');
  assert.equal(saveLine(at(5)), '<p>✓ Save 5% on every order</p>');
});

test('no discount means NO save line, never an invented one', () => {
  // Omitting a benefit costs a little persuasion; inventing one is a lie.
  assert.equal(saveLine(undefined), '');
  assert.equal(saveLine({}), '');
  assert.equal(saveLine({ pricing_polices: [] }), '');
  assert.equal(saveLine(at(0)), '');
  assert.equal(saveLine({ pricing_polices: [{ discount: { type: 'fixed_amount', value: 5 } }] }), '');
  assert.equal(saveLine({ pricing_polices: [{ discount: { type: 'percentage', value: 'abc' } }] }), '');
});

test('the alternate spelling Recurpay uses is accepted', () => {
  // The API field is `pricing_polices` (their typo); a reader that only knew
  // the correct spelling would silently drop every save line.
  assert.equal(
    saveLine({ pricing_policies: [{ discount: { type: 'percentage', value: 15 } }] }),
    '<p>✓ Save 15% on every order</p>',
  );
});

test('deriving is a NO-OP for the three plans that were hardcoded at 15%', () => {
  // The whole change must not alter copy already live on the writable plans.
  const OLD_SAVE = '<p>✓ Save 15% on every order</p>';
  const SHIP = '<p>✓ Free shipping on any subscription order</p>';
  const TAIL = '<p>✓ Pause, skip, or cancel anytime</p><p>✓ 30-day money-back guarantee</p>';
  for (const cadence of [
    '<p>✓ Delivered every 30 days</p>',
    '<p>✓ Delivered every month</p>',
    '<p>✓ Four bars, delivered every four months</p>',
  ]) {
    assert.equal(describeCopy(at(15), cadence), OLD_SAVE + SHIP + cadence + TAIL);
  }
});

test('the shipping promise is in every description, whatever the discount', () => {
  // That promise is the reason this script exists; it must not depend on there
  // being a discount to advertise alongside it.
  const out = describeCopy({}, '<p>✓ Delivered every month</p>');
  assert.match(out, /Free shipping on any subscription order/);
  assert.doesNotMatch(out, /Save/);
});

test('importing this script must not RUN it', () => {
  // It used to: the survey and the write loop sat at module scope, so the very
  // act of importing `saveLine` for these tests fired listPlans() and a
  // getPlan() per writable plan against LIVE Recurpay. Dry by default, so
  // nothing was written — but that is the failure reference_agents_run_on_import
  // documents, and it showed up as this suite taking 1.9s instead of ms.
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'sync-subscription-copy.mjs'), 'utf8');
  assert.match(src, /isDirectRun\(import\.meta\.url\)/);
  // Every live call must sit INSIDE that guard, never at module scope.
  const guardAt = src.indexOf('isDirectRun(import.meta.url)');
  for (const call of ['listPlans(', 'getPlan(', 'updatePlan(']) {
    const i = src.indexOf(`await ${call}`);
    if (i === -1) continue;
    assert.ok(i > guardAt, `${call} runs at module scope — importing this file would call Recurpay`);
  }
});
