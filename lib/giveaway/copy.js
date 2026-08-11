/**
 * Offer copy for the consolation BOGO, with every duration claim asserted
 * against measured consumption before it can be rendered.
 *
 * Bar soap is 25 days/unit (config/consumption-rates.json, merchant estimate,
 * range 20-30). So 9 free bars supports a 6-month claim and 6 free bars does
 * not. "Buy 6 get 6 = 6 months free" was proposed and rejected on 2026-08-11;
 * the regression test for it lives in tests/lib/giveaway-copy.test.js.
 *
 * A shared bar does not last 25 days, so households of 3+ get a quantity frame
 * with no duration claim at all rather than a claim we cannot support.
 */
import { assertDurationClaim } from '../supply-duration.js';

export const SOAP_VARIANT_ID = '45828179951786'; // Pure Unscented. NOT defaultVariantId.
export const SOAP_HANDLE = 'coconut-soap';
export const UNIT_PRICE = 11;

export const TIERS = {
  floor: { key: 'floor', price: 66, paidBars: 6, freeBars: 6, claimDays: 120, code: 'SOAP4MO' },
  hero: { key: 'hero', price: 99, paidBars: 9, freeBars: 9, claimDays: 180, code: 'SOAP6MO' },
};

const MONTHS = (days) => Math.round(days / 30);

export function offerCopy(tierKey, household, { claimDaysOverride = null } = {}) {
  const tier = TIERS[tierKey];
  if (!tier) throw new Error(`unknown tier: ${tierKey}`);

  const barsTotal = tier.paidBars + tier.freeBars;
  const claimDays = claimDaysOverride ?? tier.claimDays;
  const noClaim = household === 'family';

  let durationClaim = null;
  if (!noClaim) {
    // Throws if the free half cannot actually cover the claim.
    assertDurationClaim(
      claimDays,
      [{ product: SOAP_HANDLE, qty: tier.freeBars }],
      `${tier.freeBars} free bars`,
    );
    durationClaim = `${MONTHS(claimDays)} months free`;
  }

  const headline = noClaim
    ? `${barsTotal} bars — a bar in every shower, restocked`
    : `${barsTotal} bars — ${durationClaim}`;

  return {
    price: tier.price,
    barsTotal,
    barsFree: tier.freeBars,
    valueUsd: barsTotal * UNIT_PRICE,
    durationClaim,
    headline,
    cartPermalink: `/cart/${SOAP_VARIANT_ID}:${barsTotal}?discount=${tier.code}`,
  };
}
