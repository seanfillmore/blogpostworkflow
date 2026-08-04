/**
 * Bundle lander — pure helpers for the shared product.bundle-landing template.
 *
 * The value stack sums the components a bundle contains. Digital bonuses are
 * listed as contents but MUST NOT count toward the total: the total is shown
 * beside `compareAtPrice`, which is set from physical goods only. Summing the
 * digital rows too is what put "Total value $208 / You save $87" next to a
 * $174 strikethrough on the live Reset page.
 *
 * This mirrors the Liquid in the `value-stack` block. Change both together.
 */

export function computeStackTotals(stack, priceCents) {
  const rows = Array.isArray(stack) ? stack : [];
  const priced = rows.filter((r) => !r.digital);
  const included = rows.filter((r) => r.digital);
  const total = priced.reduce((s, r) => s + Number(r.amount || 0), 0);
  const price = Math.round(Number(priceCents || 0) / 100);
  return { priced, included, total, price, savings: total - price };
}
