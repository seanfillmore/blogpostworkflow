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
import { resolveTiers, validateLadder } from '../lib/quantity-ladder.js';
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

  const d = await shopifyGraphQL('{ products(first: 250) { nodes { handle status } } }');
  const statuses = Object.fromEntries(d.products.nodes.map((p) => [p.handle, { status: p.status }]));

  const errors = validateLadder(ladder, roster, statuses);
  if (errors.length) {
    console.error('Ladder is invalid — refusing to build:\n  ' + errors.join('\n  '));
    process.exit(1);
  }

  const tiers = resolveTiers(roster, ladder);
  const block = renderBlock(tiers, ladder);
  console.log(`${base}: ${tiers.length} tiers (${tiers.map((t) => t.units).join('/')} units), ${block.length} bytes`);
  writeFileSync(join(ROOT, 'data', `ladder-${base}.liquid`), block);
  console.log(`wrote data/ladder-${base}.liquid — install with update-theme-asset.mjs`);
}
