// tests/lib/giveaway-copy.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TIERS, SOAP_VARIANT_ID, offerCopy } from '../../lib/giveaway/copy.js';

test('the hero tier may claim six months free, because nine bars supports it', () => {
  const c = offerCopy('hero', 'solo');
  assert.equal(c.price, 99);
  assert.equal(c.barsTotal, 18);
  assert.equal(c.barsFree, 9);
  assert.match(c.durationClaim, /6 months/);
});

test('the floor tier claims four months, not six', () => {
  const c = offerCopy('floor', 'solo');
  assert.equal(c.barsTotal, 12);
  assert.match(c.durationClaim, /4 months/);
  assert.doesNotMatch(c.durationClaim, /6 months/);
});

test('a family household gets NO duration claim, because a shared bar does not last 25 days', () => {
  const c = offerCopy('hero', 'family');
  assert.equal(c.durationClaim, null);
  assert.match(c.headline, /every shower/i);
});

test('REGRESSION: six free bars can never claim six months', () => {
  // This is the exact framing proposed on 2026-08-11 and rejected: 6 free bars
  // is 120-150 days, not 180. If someone widens the floor tier's claim to match
  // the hero's, the guardrail must stop it before it reaches a page.
  assert.throws(
    () => offerCopy('floor', 'solo', { claimDaysOverride: 180 }),
    /claims 180 days/,
  );
});

test('the cart permalink is Pure Unscented and carries the full bar count', () => {
  // BXGY discounts do not ADD free items -- all 18 bars must be in the cart for
  // the discount to zero 9 of them. And the default variant is Calming
  // Lavender, so a permalink built from the default ships the wrong soap.
  const c = offerCopy('hero', 'solo');
  assert.equal(SOAP_VARIANT_ID, '45828179951786');
  assert.equal(c.cartPermalink, '/cart/45828179951786:18?discount=SOAP6MO');
});

test('an unknown tier is a programming error, not a silent default', () => {
  assert.throws(() => offerCopy('mega', 'solo'), /unknown tier/i);
});

test('both tiers price the free half at the bar count they actually give away', () => {
  assert.equal(TIERS.floor.freeBars, TIERS.floor.paidBars);
  assert.equal(TIERS.hero.freeBars, TIERS.hero.paidBars);
});
