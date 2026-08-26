#!/usr/bin/env node
/**
 * Render the quantity-ladder custom_liquid block and write it into a base
 * product's template.
 *
 *   node scripts/build-quantity-ladder.mjs <base-handle>
 *
 * Structure (which handles, how many units) is baked from config/bundles.json.
 * PRICES ARE NEVER BAKED — the block reads all_products at render time, so a
 * reprice cannot leave a stale number on the page.
 *
 * Refuses to write when validateLadder reports anything, which includes a tier
 * that is not ACTIVE on Shopify. That is the 2026-08-25 failure: a roster-live
 * tier serving a 404 would put an unbuyable variant behind a tier card.
 *
 * No --apply flag: this script only ever writes a local build artifact
 * (data/ladder-<base>.liquid), never a Shopify mutation, so a dry-run/apply
 * distinction would be noise. Installing the generated block onto a template
 * is a separate step (update-theme-asset.mjs).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoster } from '../lib/bundle-roster.js';
import { resolveTiers, validateLadder, freeUnitFraming } from '../lib/quantity-ladder.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The Liquid assigns the block body reads. Structure only, never prices. */
export function renderLadderPreamble(tiers, ladder) {
  return [
    `{%- assign ladder_base = "${ladder.base}" -%}`,
    `{%- assign ladder_default = "${ladder.default}" -%}`,
    `{%- assign ladder_unit_noun = "${ladder.unit_noun ?? 'unit'}" -%}`,
    `{%- assign ladder_handles = "${tiers.map((t) => t.handle).join(',')}" | split: "," -%}`,
    `{%- assign ladder_units = "${tiers.map((t) => t.units).join(',')}" | split: "," -%}`,
  ].join('\n');
}

export function renderBlock(tiers, ladder) {
  const body = readFileSync(join(ROOT, 'theme', 'blocks', 'quantity-ladder.liquid'), 'utf8');
  return `${renderLadderPreamble(tiers, ladder)}\n${body}`;
}

/**
 * The divergence check the spec ("Data model") describes and that had never
 * been built: recompute freeUnitFraming from LIVE prices for every non-base
 * tier and refuse to build when a tier's framing would be incoherent.
 *
 * `prices` maps handle -> integer cents (same units freeUnitFraming and the
 * Liquid's modulo arithmetic both use). `tiers` is resolveTiers()'s output.
 *
 * Two conservative checks, applied per non-base tier:
 *   1. tierPrice >= baseUnitPrice * units — a "multipack" priced at or above
 *      buying the units singly. Never a legitimate ladder entry: it is either
 *      a repricing accident or a tier that should not exist. freeUnitFraming
 *      alone would not catch this — at exact equality it correctly returns
 *      `savings` (paid === units), which reads as "no bug" even though a
 *      multipack with zero savings over buying singly is exactly the
 *      nonsense-saving case this validator exists to catch.
 *   2. A free-units result whose `paid` does not satisfy 0 < paid < units.
 *      freeUnitFraming as written can never actually return that shape (it
 *      falls back to `savings` itself whenever paid is out of range) — this
 *      re-checks the invariant defensively rather than trusting the import
 *      never regresses, per the brief's "at minimum" list.
 */
export function checkPricingCoherence(tiers, prices, ladder) {
  const errors = [];
  const base = tiers.find((t) => t.isBase);
  const baseUnitPrice = base ? prices[base.handle] : undefined;

  if (!Number.isInteger(baseUnitPrice) || baseUnitPrice <= 0) {
    errors.push(`${ladder.base}: no usable live price for base tier "${base?.handle ?? ladder.base}"`);
    return errors;
  }

  for (const t of tiers) {
    if (t.isBase) continue;
    const tierPrice = prices[t.handle];
    if (!Number.isInteger(tierPrice) || tierPrice <= 0) {
      errors.push(`${ladder.base}: no usable live price for tier "${t.handle}"`);
      continue;
    }

    const singlyPrice = baseUnitPrice * t.units;
    if (tierPrice >= singlyPrice) {
      errors.push(
        `${ladder.base}: tier "${t.handle}" is priced ${tierPrice}c for ${t.units} units, ` +
        `at or above buying singly (${singlyPrice}c) — refusing to build`
      );
      continue;
    }

    const framing = freeUnitFraming({ tierPrice, baseUnitPrice, units: t.units });
    if (framing.kind === 'free-units' && !(framing.paid > 0 && framing.paid < t.units)) {
      errors.push(
        `${ladder.base}: tier "${t.handle}" computed an incoherent free-unit framing ` +
        `(paid=${framing.paid}, units=${t.units}) — refusing to build`
      );
    }
  }

  return errors;
}

// Direct-run guard: this module is imported by its test, and an agent that runs
// on import is the failure mode reference_agents_run_on_import documents.
// isDirectRun() is the one tested predicate for this (lib/is-direct-run.js) —
// hand-rolled spellings of this check accumulated to five in this fleet before
// being consolidated, and two audits miscounted guarded agents as a result.
if (isDirectRun(import.meta.url)) {
  const { shopifyGraphQL } = await import('../lib/shopify.js');
  const base = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!base) { console.error('usage: build-quantity-ladder.mjs <base-handle>'); process.exit(2); }

  const roster = loadRoster();
  const ladder = (roster.ladders ?? []).find((l) => l.base === base);
  if (!ladder) { console.error(`no ladder configured for base "${base}"`); process.exit(2); }

  const d = await shopifyGraphQL(`{
    products(first: 250) {
      nodes { handle status priceRangeV2 { minVariantPrice { amount } } }
    }
  }`);
  const statuses = Object.fromEntries(d.products.nodes.map((p) => [p.handle, { status: p.status }]));
  // Integer cents, matching the units freeUnitFraming (lib/quantity-ladder.js)
  // and the Liquid's `modulo`/`divided_by` arithmetic both assume.
  const prices = Object.fromEntries(
    d.products.nodes.map((p) => [p.handle, Math.round(Number(p.priceRangeV2.minVariantPrice.amount) * 100)])
  );

  const errors = validateLadder(ladder, roster, statuses);
  if (errors.length) {
    console.error('Ladder is invalid — refusing to build:\n  ' + errors.join('\n  '));
    process.exit(1);
  }

  const tiers = resolveTiers(roster, ladder);

  // The divergence check: recompute freeUnitFraming from live prices and
  // refuse to build if any tier's framing would be incoherent. See
  // checkPricingCoherence's docstring for what "incoherent" means here.
  const pricingErrors = checkPricingCoherence(tiers, prices, ladder);
  if (pricingErrors.length) {
    console.error('Ladder pricing is incoherent — refusing to build:\n  ' + pricingErrors.join('\n  '));
    process.exit(1);
  }

  const block = renderBlock(tiers, ladder);
  console.log(`${base}: ${tiers.length} tiers (${tiers.map((t) => t.units).join('/')} units), ${block.length} bytes`);
  writeFileSync(join(ROOT, 'data', `ladder-${base}.liquid`), block);
  console.log(`wrote data/ladder-${base}.liquid — install with update-theme-asset.mjs`);
}
