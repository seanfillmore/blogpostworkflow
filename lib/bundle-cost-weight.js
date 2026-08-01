/**
 * Derive a bundle variant's cost and weight from the components it ships.
 *
 * Bundle variants in Shopify carry no cost and no weight of their own — a componentised
 * bundle is assembled at fulfilment, so nothing populates those fields automatically. The
 * consequence is not cosmetic: with `unitCost` unset, Shopify reports **100% margin** on
 * every bundle order, so profit reporting overstates and any margin analysis built on it
 * is wrong. With weight at 0, carrier-calculated rates and shipping reports are wrong too.
 *
 * Component costs come from Shopify's `inventoryItem.unitCost`, which is authoritative and
 * per-variant. The `SKUS` table in scripts/bundle-economics.mjs carries one cost per SKU
 * and already disagrees with it (Pure Unscented lotion is $4.92, the other scents $5.49) —
 * do not compute from that table.
 */

const PER_OUNCE = {
  OUNCES: 1,
  POUNDS: 16,
  GRAMS: 1 / 28.349523125,
  KILOGRAMS: 1000 / 28.349523125,
};

/** Shopify reports weight with a unit; a bundle can mix them, so normalise before summing. */
export function toOunces(value, unit) {
  const factor = PER_OUNCE[String(unit).toUpperCase()];
  if (!factor) throw new Error(`unknown weight unit: ${unit}`);
  return value * factor;
}

const money = (n) => Math.round(n * 100) / 100;

/**
 * @param components [{ product, variant, qty }] from config/bundles.json
 * @param lookup     (productHandle, variantTitle) => { unitCost, weight, weightUnit } | undefined
 * @param packaging  packaging COST in dollars (roster field; $1 on the gift box)
 *
 * Returns `{ cost, weightOz, missing }`. When any component is unknown or has no cost,
 * `cost` and `weightOz` are **null** and `missing` lists why. A partial sum would write a
 * confidently wrong number onto a live product, which is worse than writing nothing.
 */
export function computeTotals(components, lookup, { packaging = 0 } = {}) {
  const missing = [];
  let cost = packaging;
  let weightOz = 0;

  for (const c of components) {
    const data = lookup(c.product, c.variant);
    if (!data) {
      missing.push(`${c.product} / ${c.variant} — not found in Shopify`);
      continue;
    }
    if (data.unitCost == null) {
      missing.push(`${c.product} / ${c.variant} — unitCost not set in Shopify`);
      continue;
    }
    const qty = c.qty ?? 1;
    cost += data.unitCost * qty;
    if (data.weight != null) weightOz += toOunces(data.weight, data.weightUnit) * qty;
  }

  if (missing.length) return { cost: null, weightOz: null, missing };
  return { cost: money(cost), weightOz: Math.round(weightOz * 100) / 100, missing };
}
