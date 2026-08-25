// tests/lib/giveaway-consolation-offer.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDurationClaim } from '../../lib/supply-duration.js';
import {
  buildBxgyInput, cartPermalink, priceUsd, valueUsd, totalBars, barsPerOrder,
  BAR_VARIANT_ID, BUY_QUANTITY, GET_QUANTITY, OPENS_AT, CLOSES_AT, CLOSES_HUMAN,
} from '../../lib/giveaway/consolation-offer.js';

test('the offer is the spec\'s 6+6 tier: $66 for 12 bars, $132 value', () => {
  // Pinned against spec §7.3. These three numbers appear in the email copy, on
  // the offer page and in the inventory sizing — they must come from one place.
  assert.equal(priceUsd(), 66);
  assert.equal(valueUsd(), 132);
  assert.equal(totalBars(), 12);
});

test('inventory sizing is done in BARS, not orders', () => {
  // The 1,200-unit purchase order has to cover 12 bars per redemption. Reading
  // this as 6 would overstate fulfillable orders by 2x.
  assert.equal(barsPerOrder(), 12);
  assert.equal(Math.floor(1200 / barsPerOrder()), 100, '1200 bars covers 100 redemptions');
});

test('the BXGY input targets the Pure Unscented bar on both sides', () => {
  const input = buildBxgyInput();
  const gid = `gid://shopify/ProductVariant/${BAR_VARIANT_ID}`;
  assert.deepEqual(input.customerBuys.items.products.productVariantsToAdd, [gid]);
  assert.deepEqual(input.customerGets.items.products.productVariantsToAdd, [gid]);
  assert.equal(input.customerBuys.value.quantity, String(BUY_QUANTITY));
  assert.equal(input.customerGets.value.discountOnQuantity.quantity, String(GET_QUANTITY));
});

test('REGRESSION: variant ids nest under items.products, not items.productVariants', () => {
  // DiscountItemsInput has only `collections` and `products`. The obvious
  // spelling is rejected live with "Field is not defined on DiscountItemsInput"
  // — and validating the mutation DOCUMENT does not catch it, because the
  // document only names the variable. This is the payload check that does.
  const input = buildBxgyInput();
  for (const side of ['customerBuys', 'customerGets']) {
    assert.equal(input[side].items.productVariants, undefined, `${side} must not use items.productVariants`);
    assert.ok(input[side].items.products, `${side} must nest variants under items.products`);
  }
});

test('the free bars are 100% off — percentage is a fraction, not a whole number', () => {
  // effect.percentage 1.0 means 100%. Writing 100 here would be rejected, and
  // writing 0.01 would quietly ship a 1% discount that nobody notices until the
  // first order settles.
  assert.equal(buildBxgyInput().customerGets.value.discountOnQuantity.effect.percentage, 1.0);
});

test('BOTH stacking limits are set', () => {
  // usesPerOrderLimit stops a 24-bar cart taking 12 free instead of 6, which
  // doubles cost of sale on the largest orders. appliesOncePerCustomer stops
  // the same buyer redeeming repeatedly. Neither can be retrofitted.
  const input = buildBxgyInput();
  assert.equal(input.usesPerOrderLimit, 1);
  assert.equal(input.appliesOncePerCustomer, true);
});

test('the window opens with the draw and runs seven days', () => {
  const opens = Date.parse(OPENS_AT);
  const closes = Date.parse(CLOSES_AT);
  assert.ok(closes > opens, 'closes after it opens');
  const days = (closes - opens) / 86400000;
  assert.ok(days > 7 && days < 8, `expected ~7.5 days of window, got ${days.toFixed(2)}`);
});

test('REGRESSION: the human deadline in the copy matches CLOSES_AT', () => {
  // The emails print CLOSES_HUMAN. If someone extends the window and forgets
  // the string, the campaign advertises a deadline that has already passed —
  // the same class of bug that had 06-final-call stating a passed date.
  const d = new Date(CLOSES_AT);
  // CLOSES_AT is 06:59:59Z, which is 23:59:59 the PREVIOUS day in Pacific time.
  const pacific = new Date(d.getTime() - 7 * 3600 * 1000);
  const label = pacific.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  assert.equal(label, CLOSES_HUMAN);
});

test('the cart permalink preloads all 12 bars, not 6', () => {
  // A BXGY marks 6 of 12 free; it does not ADD the free ones. A permalink
  // holding 6 shows full price and reads as a broken offer.
  const url = cartPermalink();
  assert.match(url, new RegExp(`/cart/${BAR_VARIANT_ID}:12\\b`));
  assert.match(url, /[?&]discount=GIVEAWAY6X6/);
});

test('the permalink escapes the discount code', () => {
  assert.match(cartPermalink({ code: 'A B&C' }), /discount=A%20B%26C/);
});

test('the "four months free" claim is supportable by the measured consumption rate', () => {
  // Bar soap is 25 days/bar (merchant figure, range 20-30). Six free bars is
  // ~150 days at the midpoint; the page claims ~120 (4 months), the 20-day end.
  // assertDurationClaim is strict in one direction only — under-claiming is
  // fine, over-claiming throws. Over-supply promises are the documented reason
  // RSC subscribers churned, so this claim is checked, not asserted by hand.
  assert.doesNotThrow(() => assertDurationClaim(120, [{ product: 'coconut-soap', qty: 6 }], 'consolation free half'));
});

test('a "six months free" version of the same claim would be rejected', () => {
  // Guards the direction: if someone rounds the free half up, the gate fires.
  assert.throws(
    () => assertDurationClaim(180, [{ product: 'coconut-soap', qty: 6 }], 'consolation free half'),
    /stops being complete after/,
  );
});

test('the offer page prints the same deadline, price and quantity as the code', () => {
  // Three surfaces state this offer — the discount object, the page and the
  // emails. Drift between them is a customer arriving at a cart that disagrees
  // with the email that sent them.
  const page = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'theme', 'sections', 'giveaway-offer.liquid'),
    'utf8',
  );
  assert.ok(page.includes(CLOSES_HUMAN), `page must print the deadline ${CLOSES_HUMAN}`);
  assert.ok(page.includes(`$${priceUsd()}`), `page must print $${priceUsd()}`);
  assert.ok(page.includes(`${BAR_VARIANT_ID}:${totalBars()}`), 'cart link must preload all 12 bars');
  assert.ok(/No purchase necessary/i.test(page), 'spec §8 requires NPN on the offer page itself');
});
