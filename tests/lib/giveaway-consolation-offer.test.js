// tests/lib/giveaway-consolation-offer.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDurationClaim } from '../../lib/supply-duration.js';
import {
  TIERS, ANCHOR_TIER, tierByCode, tierById, buildBxgyInput, cartPermalink,
  maxBarsPerOrder, BAR_VARIANT_ID, OPENS_AT, CLOSES_AT, CLOSES_HUMAN,
} from '../../lib/giveaway/consolation-offer.js';

const PAGE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'theme', 'sections', 'giveaway-offer.liquid'),
  'utf8',
);

test('both spec tiers exist with the spec\'s economics', () => {
  // Pinned against spec §7.3: "Buy 9 bars, get 9 free — $99 · 18 bars · $198
  // value" and "Buy 6 bars, get 6 free — $66 · 12 bars · $132 value".
  assert.deepEqual(
    TIERS.map((t) => [t.code, t.priceUsd, t.totalBars, t.valueUsd]),
    [['GIVEAWAY9X9', 99, 18, 198], ['GIVEAWAY6X6', 66, 12, 132]],
  );
});

test('the anchor is the LARGER tier and is listed first', () => {
  // The anchor is why the small tier reads as modest rather than as the price.
  // Order is presentation order everywhere, so first-ness is part of the design.
  assert.equal(ANCHOR_TIER.code, 'GIVEAWAY9X9');
  assert.equal(TIERS[0], ANCHOR_TIER);
  assert.ok(ANCHOR_TIER.priceUsd > TIERS[1].priceUsd);
});

test('inventory sizing uses the LARGEST tier, not the smallest', () => {
  // 1,200 Pure Unscented bars. Sizing on 12 would overstate fulfillable orders
  // by half if buyers take the anchor.
  assert.equal(maxBarsPerOrder(), 18);
  assert.equal(Math.floor(1200 / maxBarsPerOrder()), 66, '1200 bars covers 66 anchor-tier redemptions');
});

test('each BXGY input targets the Pure Unscented bar on both sides', () => {
  const gid = `gid://shopify/ProductVariant/${BAR_VARIANT_ID}`;
  for (const tier of TIERS) {
    const input = buildBxgyInput(tier);
    assert.deepEqual(input.customerBuys.items.products.productVariantsToAdd, [gid]);
    assert.deepEqual(input.customerGets.items.products.productVariantsToAdd, [gid]);
    assert.equal(input.customerBuys.value.quantity, String(tier.buy));
    assert.equal(input.customerGets.value.discountOnQuantity.quantity, String(tier.get));
    assert.equal(input.code, tier.code);
  }
});

test('REGRESSION: variant ids nest under items.products, not items.productVariants', () => {
  // DiscountItemsInput has only `collections` and `products`. The obvious
  // spelling is rejected live with "Field is not defined on DiscountItemsInput"
  // — and validating the mutation DOCUMENT does not catch it, because the
  // document only names the variable. This is the payload check that does.
  for (const tier of TIERS) {
    const input = buildBxgyInput(tier);
    for (const side of ['customerBuys', 'customerGets']) {
      assert.equal(input[side].items.productVariants, undefined, `${tier.code} ${side}`);
      assert.ok(input[side].items.products, `${tier.code} ${side} must nest under items.products`);
    }
  }
});

test('the free bars are 100% off — percentage is a fraction, not a whole number', () => {
  for (const tier of TIERS) {
    assert.equal(buildBxgyInput(tier).customerGets.value.discountOnQuantity.effect.percentage, 1.0);
  }
});

test('BOTH stacking limits are set on BOTH tiers', () => {
  // usesPerOrderLimit stops a 36-bar cart taking 18 free instead of 9, which
  // doubles cost of sale on the largest orders.
  for (const tier of TIERS) {
    const input = buildBxgyInput(tier);
    assert.equal(input.usesPerOrderLimit, 1, tier.code);
    assert.equal(input.appliesOncePerCustomer, true, tier.code);
  }
});

test('the tiers have DISTINCT codes, or one would overwrite the other', () => {
  assert.equal(new Set(TIERS.map((t) => t.code)).size, TIERS.length);
  assert.equal(tierByCode('GIVEAWAY9X9').totalBars, 18);
  assert.equal(tierByCode('GIVEAWAY6X6').totalBars, 12);
  assert.equal(tierByCode('NOPE'), null);
  assert.equal(tierById('tier-9'), ANCHOR_TIER);
});

test('the window opens with the draw and runs seven days', () => {
  const days = (Date.parse(CLOSES_AT) - Date.parse(OPENS_AT)) / 86400000;
  assert.ok(days > 7 && days < 8, `expected ~7.5 days of window, got ${days.toFixed(2)}`);
});

test('REGRESSION: the human deadline in the copy matches CLOSES_AT', () => {
  // CLOSES_AT is 06:59:59Z, which is 23:59:59 the PREVIOUS day in Pacific time.
  const pacific = new Date(Date.parse(CLOSES_AT) - 7 * 3600 * 1000);
  const label = pacific.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  assert.equal(label, CLOSES_HUMAN);
});

test('each permalink preloads ITS OWN tier\'s full bar count', () => {
  // The trap: a BXGY discounts min(get, what is left after the prerequisite),
  // so 12 bars under the 9+9 code hands over THREE free instead of nine — no
  // error, just a worse offer than the email advertised.
  for (const tier of TIERS) {
    const url = cartPermalink(tier);
    assert.match(url, new RegExp(`/cart/${BAR_VARIANT_ID}:${tier.totalBars}\\b`), tier.code);
    assert.match(url, new RegExp(`[?&]discount=${tier.code}`), tier.code);
  }
  assert.notEqual(cartPermalink(TIERS[0]), cartPermalink(TIERS[1]));
});

test('the permalink escapes the discount code', () => {
  assert.match(cartPermalink({ ...ANCHOR_TIER, code: 'A B&C' }), /discount=A%20B%26C/);
});

test('every tier\'s free-months claim is supportable by the measured rate', () => {
  // Bar soap is 25 days/bar (merchant figure, range 20-30). Each tier claims
  // its free half at the 20-day end, so both under-claim against the midpoint.
  // assertDurationClaim is strict in the over-claiming direction only.
  for (const tier of TIERS) {
    assert.equal(tier.freeDays, tier.get * 20, `${tier.code} claims the conservative rate`);
    assert.doesNotThrow(
      () => assertDurationClaim(tier.freeDays, [{ product: 'coconut-soap', qty: tier.get }], tier.code),
      `${tier.code}: ${tier.freeMonths} months must be supportable`,
    );
    assert.equal(Math.round(tier.freeDays / 30), tier.freeMonths, `${tier.code} months match days`);
  }
});

test('claiming the free half at the 30-day end WOULD be rejected', () => {
  // Guards the direction: rounding the claim up past the measured midpoint fires.
  for (const tier of TIERS) {
    assert.throws(
      () => assertDurationClaim(tier.get * 30, [{ product: 'coconut-soap', qty: tier.get }], tier.code),
      /stops being complete after/,
      tier.code,
    );
  }
});

test('the offer page prints both tiers, each with its own cart link', () => {
  for (const tier of TIERS) {
    assert.ok(PAGE.includes(`$${tier.priceUsd}`), `page must print $${tier.priceUsd}`);
    assert.ok(PAGE.includes(`${BAR_VARIANT_ID}:${tier.totalBars}?discount=${tier.code}`),
      `page must carry ${tier.code} at ${tier.totalBars} bars`);
  }
  assert.ok(PAGE.includes(CLOSES_HUMAN), 'page must print the deadline');
  assert.ok(/No purchase necessary/i.test(PAGE), 'spec §8 requires NPN on the offer page itself');
});

test('the offer page lists the anchor BEFORE the smaller tier', () => {
  // Compare RENDERED content: Liquid comments carry example prices for the
  // mismatched-cart trap and are not shown to anyone.
  const rendered = PAGE.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '');
  const anchorAt = rendered.indexOf(`$${ANCHOR_TIER.priceUsd}`);
  const smallAt = rendered.indexOf(`$${TIERS[1].priceUsd}`);
  assert.ok(anchorAt > -1 && smallAt > -1);
  assert.ok(anchorAt < smallAt, 'the anchor must appear first, or it stops anchoring');
});
