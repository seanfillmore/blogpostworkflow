/**
 * The bundle roster — `config/bundles.json` — and the pure logic over it.
 *
 * WHY THIS FILE EXISTS
 *   A bundle's component mapping used to live in three places that could
 *   disagree: Shopify's variant relationships, the hardcoded `items` counts in
 *   scripts/bundle-economics.mjs, and prose in docs/bundle-marketing-plan.md.
 *   Disagreement there is not cosmetic — it means the financial model is
 *   describing a box we do not ship, and no demand forecast built on it can be
 *   trusted. This is the one place a bundle is defined.
 *
 *   Validation is the half that makes it authoritative. A typo'd variant title
 *   is not a cosmetic error: it silently ships the wrong scent. That has
 *   happened — a "Gentle" kit shipped cinnamon-clove toothpaste while its copy
 *   promised Fresh Mint.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Shopify product handle -> SKU key in scripts/bundle-economics.mjs. */
export const SKU_BY_HANDLE = {
  'coconut-lotion': 'lotion',
  'coconut-moisturizer': 'cream',
  'foam-soap-refill-32oz': 'refill',
  'coconut-oil-lip-balm': 'lipbalm',
  'coconut-oil-deodorant': 'deo',
  'coconut-oil-toothpaste': 'toothpaste',
  'organic-foaming-hand-soap': 'pump',
  'coconut-soap': 'barsoap',
};

/**
 * Body lotion and cream ship exactly two scents until a bundle proves demand.
 * A merchandising decision, not a stock one — `coconut-lotion` has a Calming
 * Lavender variant that is deliberately unused.
 */
const TWO_SCENT_PRODUCTS = new Set(['coconut-lotion', 'coconut-moisturizer']);
const ALLOWED_SCENTS = new Set(['Pure Unscented', 'Coconut Breeze']);

export function loadRoster(path = join(ROOT, 'config', 'bundles.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Validate a roster against the live catalogue.
 * `catalogue` maps a product handle to the list of its variant titles.
 * Returns human-readable errors; empty array means valid.
 */
export function validateRoster(roster, catalogue) {
  const errors = [];
  const seen = new Set();

  for (const b of roster.bundles) {
    const where = `${b.handle}`;

    if (seen.has(b.handle)) errors.push(`${where}: duplicate handle in roster`);
    seen.add(b.handle);

    if (b.packaging != null && b.packaging < 0) errors.push(`${where}: negative packaging cost`);

    const optionValues = Object.fromEntries((b.options ?? []).map(o => [o.name, new Set(o.values)]));

    for (const v of b.variants ?? []) {
      const vWhere = `${where} / ${Object.values(v.options ?? {}).join(' ')}`;

      for (const [name, value] of Object.entries(v.options ?? {})) {
        if (!optionValues[name]) errors.push(`${vWhere}: option "${name}" is not declared on the bundle`);
        else if (!optionValues[name].has(value)) errors.push(`${vWhere}: "${value}" is not a declared value of option "${name}"`);
      }

      for (const c of v.components ?? []) {
        const variants = catalogue[c.product];
        if (!variants) { errors.push(`${vWhere}: unknown component product "${c.product}"`); continue; }
        if (!variants.includes(c.variant)) {
          errors.push(`${vWhere}: "${c.product}" has no variant "${c.variant}" (has: ${variants.join(', ')})`);
          continue;
        }
        if (TWO_SCENT_PRODUCTS.has(c.product) && !ALLOWED_SCENTS.has(c.variant)) {
          errors.push(`${vWhere}: "${c.product}" / "${c.variant}" breaks the two-scent rule (Pure Unscented or Coconut Breeze only)`);
        }
        if (!SKU_BY_HANDLE[c.product]) errors.push(`${vWhere}: "${c.product}" has no SKU mapping in SKU_BY_HANDLE`);
        if (!Number.isInteger(c.qty) || c.qty < 1) errors.push(`${vWhere}: qty must be a positive integer, got ${c.qty}`);
      }
    }
  }
  return errors;
}

/** Aggregate one variant's components into `{ skuKey: qty }`. */
function itemsOf(variant) {
  const items = {};
  for (const c of variant.components) {
    const key = SKU_BY_HANDLE[c.product];
    items[key] = (items[key] ?? 0) + c.qty;
  }
  return items;
}

/** Stable signature for an item basket, so equal baskets collapse. */
const signature = items => Object.keys(items).sort().map(k => `${k}:${items[k]}`).join('|');

/**
 * Economics rows for one bundle, shaped for `evaluate()` in
 * scripts/bundle-economics.mjs.
 *
 * One row per DISTINCT basket, not per variant. The Clean Swap's three kits
 * hold one of each SKU and differ only by scent, so they are one row. The Hand
 * Soap Set's configurations are different baskets at different prices, so they
 * are three — and the row name carries the configuration to keep them apart.
 */
export function economicsRows(bundle) {
  const configOption = (bundle.options ?? []).find(o => o.name === 'Configuration');
  const bySignature = new Map();

  for (const v of bundle.variants) {
    const items = itemsOf(v);
    const sig = signature(items);
    if (bySignature.has(sig)) continue;
    bySignature.set(sig, {
      items,
      price: v.price,
      config: configOption ? v.options[configOption.name] : null,
    });
  }

  const multiple = bySignature.size > 1;
  const rows = [];
  for (const { items, price, config } of bySignature.values()) {
    rows.push({
      name: multiple && config ? `${bundle.title} — ${config}` : bundle.title,
      status: bundle.status,
      price,
      packaging: bundle.packaging ?? 0,
      items,
      story: bundle.story,
    });
  }

  // Order by the declared Configuration values so the report reads as a ladder.
  if (multiple && configOption) {
    const order = configOption.values;
    rows.sort((a, b) =>
      order.findIndex(c => a.name.endsWith(c)) - order.findIndex(c => b.name.endsWith(c)));
  }
  return rows;
}
