/**
 * One summation rule for a bundle's `bundle.value_stack` metafield.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * On 2026-08-30 the Coconut Reset lander showed FOUR different value figures at
 * once. Three blocks said "$180 of value … $59 in savings"; a fourth said
 * "Total value $174 … You save $53"; and Shopify's own buy box struck through
 * $174. Nothing was stale and nobody had typed a wrong number — two Liquid
 * blocks computed a total from the SAME metafield under two different rules, and
 * the entire difference between them was one row: `Free shipping $6`.
 *
 * That is a data shape problem wearing a copy problem's clothes. A page cannot
 * be kept consistent by fixing literals when the literals are computed.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * The value total is the sum of NON-DIGITAL rows — the physical goods a buyer
 * receives — and it must equal the product's Shopify compare-at price, because
 * that is the number Shopify itself strikes through in the buy box and the one
 * surface we do not render.
 *
 * The corollary is the part that actually prevents recurrence: any non-digital
 * row that is not physical product value (shipping, a "free" inclusion, a
 * courtesy line) must carry `amount: 0`. Zero rather than deleted, so the row
 * still renders as a free inclusion — and so that sum-all and sum-non-digital
 * return the same number, making the stack safe under a summation rule nobody
 * has written yet.
 */

/** Sum of rows a customer physically receives. Mirrors the theme's Liquid. */
export function nonDigitalTotal(stack) {
  if (!Array.isArray(stack)) return 0;
  return stack.reduce((sum, row) => (row?.digital ? sum : sum + (Number(row?.amount) || 0)), 0);
}

/** Sum of every row regardless of kind — what a naive consumer computes. */
export function grossTotal(stack) {
  if (!Array.isArray(stack)) return 0;
  return stack.reduce((sum, row) => sum + (Number(row?.amount) || 0), 0);
}

/**
 * Would every surface render the same number from this stack?
 *
 * @param {{stack: Array, compareAtPrice: number, price: number}} input
 * @returns {{ok: boolean, total: number, savings: number, problems: string[]}}
 */
export function checkStackConsistency({ stack, compareAtPrice, price }) {
  const problems = [];
  const total = nonDigitalTotal(stack);
  const savings = total - Number(price);

  if (!Array.isArray(stack) || stack.length === 0) {
    return { ok: false, total: 0, savings: 0, problems: ['value_stack is empty or not an array'] };
  }

  const compareAt = Number(compareAtPrice);
  if (Number.isFinite(compareAt) && compareAt > 0 && total !== compareAt) {
    // Name the rows that could be responsible rather than only the totals — a
    // bare "180 != 174" sends the reader to hunt for a typo that does not exist.
    const suspects = stack
      .filter((r) => !r?.digital && Number(r?.amount) > 0)
      .map((r) => `${r.label} $${r.amount}`);
    problems.push(
      `non-digital total $${total} does not equal the Shopify compare-at price $${compareAt}. `
      + `Non-digital rows: ${suspects.join(' + ')}. `
      + `Every row that is not physical product value must carry amount: 0.`
    );
  }

  if (Number.isFinite(Number(price)) && savings < 0) {
    problems.push(`price $${price} exceeds the stated value $${total}, so "savings" would render negative`);
  }

  // ADVISORY, deliberately not a failure. `digital: true` is a working exclusion
  // contract — every renderer in the theme skips those rows, so their amounts are
  // inert and worth keeping as the notional value of the bonuses. The 2026-08-30
  // incident was caused by a row that used NEITHER exclusion mechanism: shipping
  // was non-digital and carried $6. Policing digital rows too would delete real
  // information to guard a case the contract already covers.
  const notes = [];
  if (grossTotal(stack) !== total) {
    const valuedDigital = stack
      .filter((r) => r?.digital && Number(r?.amount) > 0)
      .map((r) => `${r.label} $${r.amount}`);
    notes.push(
      `digital rows carry notional value (${valuedDigital.join(' + ')}); a consumer that ignored the `
      + `digital flag and summed every row would get $${grossTotal(stack)} rather than $${total}.`
    );
  }

  return { ok: problems.length === 0, total, savings, problems, notes };
}
