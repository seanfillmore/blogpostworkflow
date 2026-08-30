/**
 * The consolation offer — the giveaway's entire revenue event.
 *
 * Spec: docs/superpowers/specs/2026-08-11-soap-giveaway-meta-campaign-design.md §7.
 * Nothing is sold during the 30-day entry period; the BOGO is released once,
 * after the draw, as the consolation prize for not winning. That reversal buys
 * a real reason-why for the discount and a real reason for it to expire, and it
 * means the entrant count is known before a single bar is committed.
 *
 * TWO TIERS, AND THE BIG ONE IS THE ANCHOR (spec §7.3). The 9+9 at $99 is
 * listed first and starred; the 6+6 at $66 sits under it. A single tier caps
 * AOV at whatever that tier costs — the anchor exists so the smaller tier reads
 * as the modest option rather than as the price. Shipped 6+6-only on
 * 2026-08-24 and the anchor was added the same day; if a future change collapses
 * back to one tier, that is a pricing decision, not a simplification.
 *
 * WHY PURE UNSCENTED ONLY. One variant removes the scent picker, the
 * out-of-stock-variant handling and a whole class of wrong-product bug (§7.3).
 * It also matches the prize itself, which is Pure Unscented. Confirmed
 * 2026-08-24 that the 1,200-unit purchase order is Pure Unscented, which is what
 * makes a single-variant offer fulfillable: 66 orders at the anchor tier's 18
 * bars, against an expected 3-8% take on ~450 confirmed entrants.
 *
 * WHY THE TWO LIMITS ARE NOT DECORATION. `appliesOncePerCustomer` stops one
 * buyer taking a tier repeatedly, and `usesPerOrderLimit: 1` stops a single
 * order stacking sets — without it a 36-bar cart takes 18 free bars rather than
 * 9, which doubles the giveaway's cost of sale on exactly the orders that look
 * like the best ones. Both are cheap to set and impossible to retrofit onto
 * orders already placed.
 *
 * THE TIERS CANNOT STACK IN ONE CART. Shopify accepts one discount code per
 * order unless combinations are explicitly enabled, and neither of these
 * declares any. They are separate codes, so a buyer picks one.
 *
 * A MISMATCHED CART UNDER-DELIVERS SILENTLY, which is why each tier owns its
 * permalink. A BXGY discounts min(getQuantity, what is left after the
 * prerequisite): put 12 bars in the cart and apply the 9+9 code and the buyer
 * gets THREE free, not nine, with no error anywhere. The permalink preloads
 * exactly `totalBars` for its own tier and the email gate pins the pairing.
 *
 * NOTE ON STACKING: `NEWCUSTOMER` (free shipping over $25) is live and stacks.
 * Harmless here since both tiers clear $25 — but it means there is no shipping
 * lever left to give away later in the window (§7 "margin landmines").
 */

/** Moisturizing Coconut Soap 3.4oz — Pure Unscented. The prize variant. */
export const BAR_VARIANT_ID = 45828179951786;
export const BAR_PRICE_USD = 11;

/**
 * The window. Opens with the draw (2026-09-16 12:00 PT) and runs seven days,
 * closing 2026-09-23 23:59:59 PT. Both are stored as UTC because that is what
 * the API stores; the PT intent is stated here so a future edit does not
 * silently move the deadline the emails print.
 */
export const OPENS_AT = '2026-09-16T19:00:00Z';
export const CLOSES_AT = '2026-09-24T06:59:59Z';
/** What the copy says. Must agree with CLOSES_AT — asserted by tests. */
export const CLOSES_HUMAN = 'September 23, 2026';

/**
 * `freeMonths` is the duration claim for the FREE half only, at the
 * CONSERVATIVE end of the measured rate. Bar soap is 25 days/bar (merchant
 * figure, range 20-30 — Sean, 2026-08-02, superseding a 47-day reorder gap that
 * was never consumption). At 20 days/bar the free 9 bars are ~180 days and the
 * free 6 are ~120: six and four months. At the 25-day midpoint both are ~25%
 * larger, so the claim under-promises in the direction `assertDurationClaim`
 * enforces, and both are pinned by tests against it.
 */
const TIER_SPECS = [
  { id: 'tier-9', buy: 9, get: 9, code: 'GIVEAWAY9X9', anchor: true, freeMonths: 6 },
  { id: 'tier-6', buy: 6, get: 6, code: 'GIVEAWAY6X6', anchor: false, freeMonths: 4 },
];

/** Anchor first — the order tiers are presented in, everywhere. */
export const TIERS = TIER_SPECS.map((t) => ({
  ...t,
  priceUsd: t.buy * BAR_PRICE_USD,
  valueUsd: (t.buy + t.get) * BAR_PRICE_USD,
  totalBars: t.buy + t.get,
  /** Days of supply the FREE half represents, at the conservative 20-day rate. */
  freeDays: t.get * 20,
  title: `Buy ${t.buy} bars, get ${t.get} free`,
}));

export const ANCHOR_TIER = TIERS.find((t) => t.anchor);
export const tierByCode = (code) => TIERS.find((t) => t.code === code) ?? null;
export const tierById = (id) => TIERS.find((t) => t.id === id) ?? null;

/** Bars consumed per redemption of the largest tier — the sizing worst case. */
export const maxBarsPerOrder = () => Math.max(...TIERS.map((t) => t.totalBars));

/**
 * The DiscountCodeBxgyInput for discountCodeBxgyCreate, for one tier.
 *
 * Pure so the shape is asserted by tests rather than discovered by creating a
 * wrong discount on a live store.
 *
 * THE ITEMS NESTING IS items.products.productVariantsToAdd, WHICH READS WRONG.
 * `DiscountItemsInput` has exactly two fields, `collections` and `products`;
 * there is no `productVariants` key, and variant ids go inside `products`
 * (a DiscountProductsInput, which carries both productsToAdd and
 * productVariantsToAdd). The obvious spelling — items.productVariants — is
 * rejected with "Field is not defined on DiscountItemsInput".
 *
 * Worth stating because validating the MUTATION DOCUMENT does not catch it:
 * the document only references $bxgyCodeDiscount by name, so it validates
 * cleanly while the variables are wrong. Schema-validating the query is not
 * schema-validating the payload.
 */
export function buildBxgyInput(tier, {
  variantId = BAR_VARIANT_ID,
  startsAt = OPENS_AT,
  endsAt = CLOSES_AT,
} = {}) {
  if (!tier) throw new Error('buildBxgyInput requires a tier');
  const gid = `gid://shopify/ProductVariant/${variantId}`;
  return {
    title: `Giveaway consolation — ${tier.title.toLowerCase()}`,
    code: tier.code,
    startsAt,
    endsAt,
    // One redemption per customer, one set per order. See the header.
    appliesOncePerCustomer: true,
    usesPerOrderLimit: 1,
    customerSelection: { all: true },
    customerBuys: {
      value: { quantity: String(tier.buy) },
      items: { products: { productVariantsToAdd: [gid] } },
    },
    customerGets: {
      value: {
        discountOnQuantity: {
          quantity: String(tier.get),
          effect: { percentage: 1.0 }, // 1.0 == 100% off, not 1%
        },
      },
      items: { products: { productVariantsToAdd: [gid] } },
    },
  };
}

/**
 * A cart permalink that preloads this tier's FULL bar count and applies its
 * code, so the offer page is "one tap" (§7.3).
 *
 * The buyer must have the whole quantity in the cart for a BXGY to pay out —
 * the discount marks the free half of what is there, it does not add the free
 * ones. See the mismatched-cart note in the header: too few bars silently
 * under-delivers rather than erroring.
 */
export function cartPermalink(tier, {
  shopDomain = 'www.realskincare.com',
  variantId = BAR_VARIANT_ID,
} = {}) {
  if (!tier) throw new Error('cartPermalink requires a tier');
  return `https://${shopDomain}/cart/${variantId}:${tier.totalBars}?discount=${encodeURIComponent(tier.code)}`;
}
