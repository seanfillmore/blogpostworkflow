/**
 * The consolation offer — the giveaway's entire revenue event.
 *
 * Spec: docs/superpowers/specs/2026-08-11-soap-giveaway-meta-campaign-design.md §7.
 * Nothing is sold during the 30-day entry period; the BOGO is released once,
 * after the draw, as the consolation prize for not winning. That reversal buys
 * a real reason-why for the discount and a real reason for it to expire, and it
 * means the entrant count is known before a single bar is committed.
 *
 * WHY PURE UNSCENTED ONLY. One variant removes the scent picker, the
 * out-of-stock-variant handling and a whole class of wrong-product bug (§7.3).
 * It also matches the prize itself, which is Pure Unscented.
 *
 * WHY THE TWO LIMITS ARE NOT DECORATION. `appliesOncePerCustomer` stops one
 * buyer taking the offer repeatedly, and `usesPerOrderLimit: 1` stops a single
 * order stacking sets — without it a 24-bar cart takes 12 free bars rather than
 * 6, which doubles the giveaway's cost of sale on exactly the orders that look
 * like the best ones. Both are cheap to set and impossible to retrofit onto
 * orders already placed.
 *
 * NOTE ON STACKING: `NEWCUSTOMER` (free shipping over $25) is live and stacks.
 * Harmless here since $66 clears $25 — but it means there is no shipping lever
 * left to give away later in the window (§7 "margin landmines").
 */

/** Moisturizing Coconut Soap 3.4oz — Pure Unscented. The prize variant. */
export const BAR_VARIANT_ID = 45828179951786;
export const BAR_PRICE_USD = 11;

/** Buy this many at full price... */
export const BUY_QUANTITY = 6;
/** ...and get this many free. */
export const GET_QUANTITY = 6;

export const DISCOUNT_CODE = 'GIVEAWAY6X6';
export const DISCOUNT_TITLE = 'Giveaway consolation — buy 6 bars get 6 free';

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

/** What the buyer pays, and what they'd have paid without the offer. */
export const priceUsd = () => BUY_QUANTITY * BAR_PRICE_USD;
export const valueUsd = () => (BUY_QUANTITY + GET_QUANTITY) * BAR_PRICE_USD;
export const totalBars = () => BUY_QUANTITY + GET_QUANTITY;

/** Bars consumed per redemption — the number inventory sizing must be done in. */
export const barsPerOrder = () => totalBars();

/**
 * The DiscountCodeBxgyInput for discountCodeBxgyCreate.
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
export function buildBxgyInput({
  code = DISCOUNT_CODE,
  title = DISCOUNT_TITLE,
  variantId = BAR_VARIANT_ID,
  buyQuantity = BUY_QUANTITY,
  getQuantity = GET_QUANTITY,
  startsAt = OPENS_AT,
  endsAt = CLOSES_AT,
} = {}) {
  const gid = `gid://shopify/ProductVariant/${variantId}`;
  return {
    title,
    code,
    startsAt,
    endsAt,
    // One redemption per customer, one set per order. See the header.
    appliesOncePerCustomer: true,
    usesPerOrderLimit: 1,
    customerSelection: { all: true },
    customerBuys: {
      value: { quantity: String(buyQuantity) },
      items: { products: { productVariantsToAdd: [gid] } },
    },
    customerGets: {
      value: {
        discountOnQuantity: {
          quantity: String(getQuantity),
          effect: { percentage: 1.0 }, // 1.0 == 100% off, not 1%
        },
      },
      items: { products: { productVariantsToAdd: [gid] } },
    },
  };
}

/**
 * A cart permalink that preloads the full 12 bars and applies the code, so the
 * offer page is "one tap" (§7.3) rather than an instruction to add six, then
 * six more, then type a code.
 *
 * The buyer must have all 12 in the cart for a BXGY to pay out — the discount
 * marks 6 of the 12 free, it does not add the free ones. Sending them to a cart
 * holding only 6 shows full price and reads as a broken offer.
 */
export function cartPermalink({
  shopDomain = 'www.realskincare.com',
  variantId = BAR_VARIANT_ID,
  code = DISCOUNT_CODE,
  quantity = totalBars(),
} = {}) {
  return `https://${shopDomain}/cart/${variantId}:${quantity}?discount=${encodeURIComponent(code)}`;
}
