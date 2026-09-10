import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, decideEntry, occurrences, main }
  from '../../scripts/remediate-petrolatum-avoidance-claim.mjs';
import { checkSeoCopy } from '../../lib/seo-copy-health-gate.js';

// The real live body_html span, copied from /products/coconut-lotion on 2026-09-09.
const LIVE = '<ul>\n<li>\n<strong>Undiluted fragrance.</strong> Light, and it fades.</li>\n'
  + '<li>\n<strong>Six ingredients.</strong> Built on coconut oil, jojoba and red palm oil. '
  + 'No mineral oil, no petrolatum, no synthetic fragrance, no parabens.</li>\n</ul>';

test('the plan is a fixed table, not a pattern sweep', () => {
  assert.equal(PLAN.length, 1);
  for (const e of PLAN) {
    for (const k of ['id', 'handle', 'productId', 'field', 'before', 'after', 'reason', 'expectedOccurrences']) {
      assert.ok(e[k] !== undefined && e[k] !== '', `entry ${e.id} needs ${k}`);
    }
    assert.notEqual(e.before, e.after);
  }
});

test('the edit removes only the unsupported terms and keeps the searched ones', () => {
  const e = PLAN[0];
  assert.match(e.before, /no mineral oil/i);
  assert.match(e.before, /no petrolatum/i);
  // The two with no evidence and no search volume go.
  assert.doesNotMatch(e.after, /mineral oil/i);
  assert.doesNotMatch(e.after, /petrolatum/i);
  // The two customers actually search stay — this is the scope line.
  assert.match(e.after, /no synthetic fragrance/i);
  assert.match(e.after, /no parabens/i);
  // And the positive ingredient statement is untouched.
  assert.match(e.after, /coconut oil, jojoba and red palm oil/);
});

test('every AFTER clears the health gate', () => {
  for (const e of PLAN) {
    assert.equal(checkSeoCopy({ meta: e.after }).ok, true, `${e.id} AFTER must be gate-clean`);
  }
});

test('the BEFORE occurs in the real live body exactly as declared', () => {
  const e = PLAN[0];
  assert.equal(occurrences(LIVE, e.before), e.expectedOccurrences);
});

test('applies against the real live body, and is idempotent', () => {
  const e = PLAN[0];
  const first = decideEntry(e, LIVE);
  assert.equal(first.action, 'apply');
  assert.doesNotMatch(first.next, /petrolatum/i);
  assert.match(first.next, /no parabens/);
  // Running again on the result must not write a second time.
  assert.equal(decideEntry(e, first.next).action, 'already-applied');
});

test('SKIPS rather than overwriting when the copy has moved since the plan', () => {
  // Somebody reworded the sentence — blind replacement would clobber their edit.
  const moved = LIVE.replace('No mineral oil, no petrolatum,', 'No mineral oil or petrolatum,');
  const d = decideEntry(PLAN[0], moved);
  assert.equal(d.action, 'skip');
  assert.match(d.why, /neither BEFORE nor AFTER/);
});

test('skips on a wrong occurrence count rather than replacing all of them', () => {
  const doubled = LIVE + LIVE;
  const d = decideEntry(PLAN[0], doubled);
  assert.equal(d.action, 'skip');
  assert.match(d.why, /expected 1 occurrence/);
});

test('a missing or non-string live value is skipped, never written', () => {
  assert.equal(decideEntry(PLAN[0], undefined).action, 'skip');
  assert.equal(decideEntry(PLAN[0], null).action, 'skip');
  assert.equal(decideEntry(PLAN[0], 42).action, 'skip');
});

test('DRY RUN performs no Shopify write', async () => {
  const calls = [];
  const shopify = {
    getProduct: async () => ({ body_html: LIVE }),
    updateProduct: async (...a) => { calls.push(a); return {}; },
  };
  const argv = process.argv;
  process.argv = ['node', 'script'];           // no --apply
  try { await main({ shopify }); } finally { process.argv = argv; }
  assert.equal(calls.length, 0, 'a dry run must never call updateProduct');
});
