import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN,
  classifyPlanEntry,
  gatePlan,
} from '../../scripts/state-return-shipping-policy.js';
import { applyEntry } from '../../scripts/remediate-dropship-era-shipping-copy.js';

const byId = (id) => PLAN.find((e) => e.id === id);
const OPERATOR_QUOTE_MARKERS = ['ship back open product', 'issue a shipping label'];

test('every entry traces to the operator quote', () => {
  for (const e of PLAN) {
    assert.ok(e.sourcedFrom, `${e.id} has no sourcedFrom`);
  }
  // At least one entry must carry the quote itself, or the provenance is hearsay.
  const quoted = PLAN.filter((e) => OPERATOR_QUOTE_MARKERS.every((m) => e.sourcedFrom.includes(m)));
  assert.ok(quoted.length >= 1, 'no entry carries the operator quote verbatim');
});

test('every AFTER passes the SEO-copy health gate', () => {
  const res = gatePlan(PLAN);
  assert.equal(res.ok, true, JSON.stringify(res.failures));
});

test('the policy asserted is the policy given — both halves, no more', () => {
  const faq = byId('faq-return-answer').after;
  // 1. opened product is not shipped back
  assert.match(faq, /don’t ship it back/i);
  assert.match(faq, /don’t ask you to return opened product/i);
  // 2. our mistake on a LARGER order, unopened → prepaid label
  assert.match(faq, /larger order/i);
  assert.match(faq, /unopened/i);
  assert.match(faq, /prepaid shipping label/i);
});

test('nothing widens the promise past what the operator said', () => {
  for (const e of PLAN) {
    // No blanket free-returns promise: the label is scoped to OUR mistake on a
    // large unopened order, and saying otherwise invents policy in the customer's
    // favour — still inventing.
    assert.equal(/free returns?/i.test(e.after), false, `${e.id} promises free returns`);
    assert.equal(/return shipping is free/i.test(e.after), false, `${e.id} over-promises`);
    // No new refund window. 30 days is what the live policy already published.
    assert.equal(/\b(45|60|90)[- ]day/i.test(e.after), false, `${e.id} invents a window`);
  }
});

test('the contradicting cancel line moves in the same change', () => {
  // Left alone it would sit two paragraphs below "please don't ship it back".
  const cancel = byId('faq-cancel-answer');
  assert.match(cancel.before, /send it back under our return policy/i);
  assert.equal(/send it back/i.test(cancel.after), false);
});

test('an INSERTION entry must declare a sentinel, or it applies forever', () => {
  // Derived from the entry itself rather than hardcoded to one id: if a later
  // entry's AFTER contains its own BEFORE, it is an insertion and needs this too.
  for (const e of PLAN) {
    if (e.kind === 'substring' && e.after.includes(e.before)) {
      assert.ok(e.sentinel, `${e.id} is an insertion entry with no sentinel`);
      assert.ok(e.after.includes(e.sentinel), `${e.id} sentinel is not in its AFTER`);
      assert.equal(
        e.before.includes(e.sentinel),
        false,
        `${e.id} sentinel also occurs in BEFORE, so it can never distinguish the two`
      );
    }
  }
});

test('the insertion is idempotent — applying twice adds one section, not two', () => {
  const e = byId('refund-policy-return-shipping');
  const live = '<p>REFUND / RETURN</p>\n<p>thirty days.</p>\n<p>DAMAGES AND ISSUES</p>\n<p>inspect it.</p>';
  assert.equal(classifyPlanEntry(live, e).action, 'apply');

  const once = applyEntry(live, e);
  assert.equal(once.split('<p>RETURN SHIPPING</p>').length - 1, 1);
  // The anchor survives in the AFTER, which is exactly why the naive check re-fired.
  assert.ok(once.includes(e.before));
  assert.equal(classifyPlanEntry(once, e).action, 'already-applied');
});

test('a hand-edited page is skipped, never overwritten', () => {
  for (const e of PLAN) {
    assert.equal(classifyPlanEntry('<p>somebody rewrote this</p>', e).action, 'drift');
    assert.equal(classifyPlanEntry('', e).action, 'drift');
  }
});

test('no AFTER emits an entity Shopify would decode on the way in', () => {
  for (const e of PLAN) {
    assert.equal(/&(ndash|mdash|rsquo|nbsp);/.test(e.after), false, `${e.id} emits an entity`);
  }
});
