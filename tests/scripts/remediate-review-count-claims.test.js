import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCounterIsTrue, applyCounter, COUNTER_BEFORE, COUNTER_AFTER, MEASURED, PDP_PLAN, SECTION, FIELD,
} from '../../scripts/remediate-review-count-claims.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

const templateWith = (counter) => ({
  sections: { [SECTION]: { settings: { [FIELD]: `<style>x</style><p class="c">${counter}</p><a href="#">Read more reviews →</a>` } } },
});

test('the AFTER counter is true against the measured corpus', () => {
  const { reviews, fiveStar } = assertCounterIsTrue();
  assert.ok(reviews <= MEASURED.publishedRecords);
  assert.ok(fiveStar <= MEASURED.publishedFiveStar);
});

test('the BEFORE counter would FAIL the same check — the claim was really wrong', () => {
  assert.throws(() => assertCounterIsTrue(COUNTER_BEFORE), /reviews|verified/);
});

test('the word "verified" cannot return unless the number drops to 51', () => {
  // `verified` is 'nothing' on 333 of 390 records — the WORD was the biggest error.
  assert.doesNotMatch(COUNTER_AFTER, /verified/i);
  assert.throws(() => assertCounterIsTrue('300+ verified reviews · 250+ five-star ratings'), /verified/);
  assert.doesNotThrow(() => assertCounterIsTrue('51+ verified reviews · 250+ five-star ratings'));
});

test('a claim above either measured figure is refused', () => {
  assert.throws(() => assertCounterIsTrue('400+ reviews · 250+ five-star ratings'), /only 307/);
  assert.throws(() => assertCounterIsTrue('300+ reviews · 290+ five-star ratings'), /only 256/);
});

test('the counter is stated on ONE basis, and it is the one the link shows', () => {
  // Record basis (307/256) rather than distinct (233/182), because the counter
  // sits above a link to the widget that displays those records.
  const { reviews } = assertCounterIsTrue();
  assert.ok(reviews > MEASURED.distinctBodies, 'record basis is the larger one — say so if this flips');
});

test('250+ survives the dedupe as the FIVE-STAR figure', () => {
  // It was approved against a pre-dedupe distinct count of 252; that basis now
  // reads 233, so "250+ reviews" would be false. It is true of five-star.
  const { fiveStar } = assertCounterIsTrue();
  assert.equal(fiveStar, 250);
  assert.ok(250 > MEASURED.distinctBodies, 'and would NOT be true of distinct reviews');
});

test('both copies pass the health gate', () => {
  assert.equal(checkSeoCopyFields({ counter: COUNTER_AFTER }).ok, true);
  for (const p of PDP_PLAN) assert.equal(checkSeoCopyFields({ t: p.after }).ok, true);
});

test('the counter swap leaves the surrounding markup alone', () => {
  const before = templateWith(COUNTER_BEFORE);
  const { template, changed } = applyCounter(before);
  assert.equal(changed, true);
  const f = template.sections[SECTION].settings[FIELD];
  assert.ok(f.includes(COUNTER_AFTER));
  assert.ok(!f.includes(COUNTER_BEFORE));
  assert.ok(f.includes('<style>x</style>') && f.includes('Read more reviews →'));
});

test('re-running is a no-op, and drifted markup is skipped', () => {
  const once = applyCounter(templateWith(COUNTER_BEFORE)).template;
  assert.equal(applyCounter(once).why, 'already applied');
  const drifted = templateWith('900+ reviews hand-edited');
  const r = applyCounter(drifted);
  assert.equal(r.changed, false);
  assert.equal(r.why, 'live markup matches neither BEFORE nor AFTER');
});

test('every PDP entry records the evidence that made it a defect', () => {
  for (const p of PDP_PLAN) {
    assert.ok(Number.isInteger(p.reviewId), p.handle);
    assert.ok(p.verified && !['verified-purchase', 'buyer'].includes(p.verified),
      `${p.handle}: only a NON-purchase verified value justifies dropping the word`);
    assert.match(p.before, /verified/i);
    assert.doesNotMatch(p.after, /verified/i);
  }
});

test('the quote itself is never edited — only the attribution', () => {
  for (const p of PDP_PLAN) {
    assert.ok(p.before.startsWith('—') && p.after.startsWith('—'), 'both sides are the attribution line');
  }
});

test('the input template is never mutated', () => {
  const input = templateWith(COUNTER_BEFORE);
  const snap = JSON.stringify(input);
  applyCounter(input);
  assert.equal(JSON.stringify(input), snap);
});
