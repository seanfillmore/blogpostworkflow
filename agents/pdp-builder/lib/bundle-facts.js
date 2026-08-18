// agents/pdp-builder/lib/bundle-facts.js
//
// Turns a Shopify bundle product (productByHandle + productVariantComponents)
// into the FACT SHEET a copy prompt is allowed to write from.
//
// Nothing in here is estimated. Every component, scent, quantity and dollar
// figure is read off the live Shopify payload; savings are arithmetic on
// component variant prices, never a guess. If a bundle is not cheaper than its
// parts, `savings.claimable` is false and the copy gate below (validateSavingsClaim)
// forbids any savings language at all rather than letting the writer spin it.
//
// Why a separate module from assemble-bundle.js: this is pure and synchronous, so
// the arithmetic is unit-testable without a Shopify call or a Claude call.

/**
 * Maps a component product handle to its cluster key in config/ingredients.json.
 * Derived from the config itself (`shopify_handle`) rather than hardcoded, so a
 * handle rename in config propagates instead of silently mis-clustering.
 */
export function clusterIndexByHandle(ingredientsByCluster) {
  const out = {};
  for (const [cluster, spec] of Object.entries(ingredientsByCluster || {})) {
    if (spec?.shopify_handle) out[spec.shopify_handle] = cluster;
  }
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolves a Shopify component variant title to the canonical scent name in
 * config/ingredients.json.
 *
 * Why this exists: the live deodorant variant used to be titled "Wildcrafted
 * Frankincence" — a misspelling in Shopify, corrected at source on 2026-08-18, so
 * `shopify_option` and `name` now agree for that scent. The function is NOT dead.
 * config/ingredients.json remains the source of truth for ingredient and scent
 * naming, and the old spelling is still reachable: historical orders keep their
 * original line-item titles, and artifacts generated before the rename (e.g.
 * data/bundles/descriptions/coconut-deodorant-4-pack.json) still carry it. Such a
 * title must not propagate into published copy. `shopify_option` stays in the
 * schema because it is exactly where a FUTURE divergence gets recorded — it is a
 * general mechanism that happened to have one occupant.
 *
 * Resolution order: exact match on shopify_option or name, then a near-miss on the
 * normalised form (edit distance <= 2). Anything further apart is left verbatim,
 * because a real difference is data we do not get to overwrite.
 *
 * @returns {{ name: string, corrected: null | { from: string, to: string } }}
 */
export function canonicalScent(rawTitle, clusterSpec) {
  const raw = String(rawTitle || '').trim();
  const variations = clusterSpec?.variations || [];
  const result = (name) => ({ name, corrected: name === raw ? null : { from: raw, to: name } });
  if (!raw || !variations.length) return result(raw);

  const target = norm(raw);
  for (const v of variations) {
    for (const candidate of [v.shopify_option, v.name]) {
      if (candidate && norm(candidate) === target) return result(v.name);
    }
  }
  let best = null;
  for (const v of variations) {
    const d = levenshtein(target, norm(v.name));
    if (best === null || d < best.d) best = { d, name: v.name };
  }
  if (best && best.d > 0 && best.d <= 2) return result(best.name);
  return result(raw);
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Builds the bundle fact sheet.
 *
 * @param {Object} args
 * @param {Object} args.product              productByHandle payload (GraphQL shape)
 * @param {Object} args.ingredientsByCluster parsed config/ingredients.json
 * @returns {Object} facts
 * @throws if a component product handle is not in config/ingredients.json — an
 *         unknown component means we cannot state its ingredients, and guessing is
 *         exactly what this agent is forbidden to do.
 */
export function buildBundleFacts({ product, ingredientsByCluster }) {
  if (!product) throw new Error('buildBundleFacts: product is required');
  const byHandle = clusterIndexByHandle(ingredientsByCluster);
  const variantNodes = product?.variants?.nodes || [];
  if (!variantNodes.length) throw new Error(`buildBundleFacts: ${product.handle} has no variants`);

  const scentCorrections = [];
  const clusters = new Set();
  const variants = [];

  for (const v of variantNodes) {
    const compNodes = v?.productVariantComponents?.nodes || [];
    if (!compNodes.length) {
      throw new Error(
        `buildBundleFacts: ${product.handle} variant "${v.title}" has no productVariantComponents — ` +
        `it is not a Shopify bundle variant, so its composition cannot be derived`,
      );
    }
    const components = [];
    let partsTotal = 0;
    let unitCount = 0;
    for (const c of compNodes) {
      const cv = c.productVariant;
      const handle = cv?.product?.handle;
      const cluster = byHandle[handle];
      if (!cluster) {
        throw new Error(
          `buildBundleFacts: component handle "${handle}" (in ${product.handle}) is not in ` +
          `config/ingredients.json — add it there before writing copy about it`,
        );
      }
      clusters.add(cluster);
      const spec = ingredientsByCluster[cluster];
      const { name: scent, corrected } = canonicalScent(cv.title, spec);
      if (corrected && !scentCorrections.some((x) => x.from === corrected.from)) {
        scentCorrections.push({ ...corrected, handle });
      }
      const qty = Number(c.quantity) || 0;
      const unitPrice = money(cv.price);
      partsTotal += qty * unitPrice;
      unitCount += qty;
      components.push({
        qty,
        handle,
        cluster,
        productName: spec.name,
        // The live Shopify product title, kept alongside the config name because
        // it can carry pack information the config does not model: the gift box's
        // lip balm component is "…| 0.15oz | Four Pack", so calling it "1x Lip Balm"
        // and nothing else led a draft to describe it as a single tube.
        shopifyProductTitle: cv?.product?.title || '',
        format: spec.format,
        scent,
        shopifyVariantTitle: cv.title,
        unitPrice,
        lineTotal: money(qty * unitPrice),
      });
    }
    partsTotal = money(partsTotal);
    const price = money(v.price);
    const savings = money(partsTotal - price);
    variants.push({
      title: v.title,
      price,
      unitCount,
      pricePerUnit: unitCount ? money(price / unitCount) : null,
      components,
      partsTotal,
      savings,
      savingsPct: partsTotal > 0 ? Math.round((savings / partsTotal) * 100) : 0,
    });
  }

  const savingsValues = variants.map((v) => v.savings);
  const claimable = savingsValues.every((s) => s > 0);
  const minSavings = money(Math.min(...savingsValues));
  const maxSavings = money(Math.max(...savingsValues));

  const clusterList = [...clusters];
  const ingredientsUsed = [];
  for (const cluster of clusterList) {
    for (const ing of (ingredientsByCluster[cluster]?.base_ingredients || [])) {
      if (!ingredientsUsed.includes(ing)) ingredientsUsed.push(ing);
    }
  }

  return {
    handle: product.handle,
    title: product.title,
    status: product.status,
    productType: product.productType || '',
    tags: product.tags || [],
    clusters: clusterList,
    variants,
    ingredientsUsed,
    scentCorrections,
    savings: {
      claimable,
      uniform: minSavings === maxSavings,
      minSavings,
      maxSavings,
      minPct: Math.min(...variants.map((v) => v.savingsPct)),
      maxPct: Math.max(...variants.map((v) => v.savingsPct)),
    },
  };
}

/**
 * Every dollar figure the copy is permitted to print, as a Set of numbers.
 * Anything else is a fabricated price and fails validateSavingsClaim.
 */
export function allowedMoneyFigures(facts) {
  const out = new Set();
  for (const v of facts.variants) {
    out.add(v.price);
    out.add(v.partsTotal);
    if (v.savings > 0) out.add(v.savings);
    if (v.pricePerUnit != null) out.add(v.pricePerUnit);
    for (const c of v.components) {
      out.add(c.unitPrice);
      out.add(c.lineTotal);
    }
  }
  return out;
}

/**
 * Extracts volume/weight tokens from a string as normalised ounce values.
 * "3.4oz", "3.4 oz" and "3.4 fl oz" all reduce to 3.4 — the fl/dry distinction is
 * not one our labels make, and treating them apart would flag correct copy.
 */
export function sizeTokens(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?(?:oz|ounces?)\b/gi)) {
    out.add(Number(m[1]));
  }
  return out;
}

/**
 * Every product size the copy is permitted to state, taken from the live Shopify
 * product titles of the components ("… | 3.4oz", "… | 2oz").
 *
 * Why: a draft described the toothpaste as a "4 fl oz squeeze bottle". No size for
 * that SKU exists anywhere in this repo or in Shopify — the model supplied a
 * plausible number. A size on a product page is a factual claim like any other.
 */
export function allowedSizes(facts) {
  const out = new Set();
  for (const v of facts.variants) {
    for (const c of v.components) for (const n of sizeTokens(c.shopifyProductTitle)) out.add(n);
  }
  return out;
}

/** Every percentage the copy is permitted to print. */
export function allowedPercentFigures(facts) {
  const out = new Set();
  if (!facts.savings.claimable) return out;
  for (const v of facts.variants) if (v.savingsPct > 0) out.add(v.savingsPct);
  return out;
}
