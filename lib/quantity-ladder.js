/**
 * Quantity ladders — the pure logic behind the tier selector on a PDP.
 *
 * A ladder spans a single-unit product and its multipacks, which is why it is
 * configured at the TOP LEVEL of config/bundles.json rather than on a bundle
 * entry: the base product is a *component*, and components have no entry in
 * bundles[] at all.
 *
 * Prices never appear here. Unit counts come from componentization; prices are
 * read live from Shopify at render time (docs/bundle-landing-architecture.md:
 * "Nothing is a literal, and no total is ever asserted — it is summed").
 */

/** Units in one purchase of a bundle: the sum of its component quantities. */
export function tierUnits(bundle) {
  const variant = bundle?.variants?.[0];
  if (!variant) return 0;
  return (variant.components ?? []).reduce((n, c) => n + (c.qty ?? 0), 0);
}

/**
 * Ordered tier descriptors. The base product is not in the roster (it is a
 * component, not a bundle), so it is always 1 unit by definition.
 */
export function resolveTiers(roster, ladder) {
  const byHandle = Object.fromEntries((roster?.bundles ?? []).map((b) => [b.handle, b]));
  return (ladder?.tiers ?? []).map((handle) => {
    const isBase = handle === ladder.base;
    return { handle, units: isBase ? 1 : tierUnits(byHandle[handle]), isBase };
  });
}

/**
 * Which framing a tier earns.
 *
 * "Buy 8, get 4 free" is only honest when the price divides EXACTLY into a
 * whole number of single units. All prices here are integer cents, so the
 * check is an exact integer remainder — not a float-tolerance comparison.
 * The same free-unit rule is implemented a second time in Liquid using
 * `modulo == 0`; a tolerance-based check here would disagree with that at
 * prices like 8801/1100, letting the two sides render different framings for
 * the same tier. Across the live catalogue exactly ONE tier qualifies — the
 * soap 12-pack at 8800/1100 = 8. The others (39/11, 53/15, 34/13) are
 * percentage discounts, and rendering them as free units prints "buy 3.5, get
 * 0.5 free". The savings label is the normal path.
 */
export function freeUnitFraming({ tierPrice, baseUnitPrice, units }) {
  if (!baseUnitPrice || !units) return { kind: 'savings' };
  if (tierPrice % baseUnitPrice !== 0) return { kind: 'savings' };
  const paid = tierPrice / baseUnitPrice;
  if (paid <= 0 || paid >= units) return { kind: 'savings' };
  return { kind: 'free-units', paid, free: units - paid };
}

/** Human-readable errors; empty array means the ladder is coherent. */
export function validateLadder(ladder, roster, catalogue) {
  const errors = [];
  const cat = catalogue ?? {};
  const tiers = resolveTiers(roster, ladder);

  if (!tiers.some((t) => t.handle === ladder?.default)) {
    errors.push(`${ladder?.base}: default "${ladder?.default}" is not one of the tiers`);
  }

  let previousUnits = 0;
  for (const t of tiers) {
    const p = cat[t.handle];
    if (!p) {
      errors.push(`${ladder.base}: tier "${t.handle}" is not in the catalogue`);
      continue;
    }
    // The 2026-08-25 failure mode: roster says live, Shopify serves a draft, the
    // tier 404s and the ladder would add an unbuyable variant to the cart.
    if (p.status !== 'ACTIVE') {
      errors.push(`${ladder.base}: tier "${t.handle}" is ${p.status}, not ACTIVE — it would 404`);
      continue;
    }
    if (!Number.isInteger(t.units) || t.units < 1) {
      errors.push(`${ladder.base}: tier "${t.handle}" has non-positive units (${t.units})`);
      continue;
    }
    if (t.units <= previousUnits) {
      errors.push(`${ladder.base}: tier "${t.handle}" units must increase along the ladder (${t.units} after ${previousUnits})`);
    }
    previousUnits = Math.max(previousUnits, t.units);
  }
  return errors;
}
