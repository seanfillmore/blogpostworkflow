#!/usr/bin/env node
/**
 * Collapse bundle-lander sections that have no data, instead of leaving 72px of
 * empty padding behind each one.
 *
 *   node scripts/hide-empty-lander-sections.mjs            # dry
 *   node scripts/hide-empty-lander-sections.mjs --apply     # writes theme/ only
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * Every data-driven section on `product.bundle-landing.json` guards its CONTENT
 * and not its WRAPPER:
 *
 *     <style>…css…</style>
 *     {%- assign tl = product.metafields.bundle.lander.value.timeline.value -%}
 *     {%- if tl != blank and tl.size > 0 -%} <section>…</section> {%- endif -%}
 *
 * The `<div class="section--padding">` around that is emitted by the THEME's
 * custom-liquid section, not by this Liquid, and it carries
 * `--section-padding-top: 36px; --section-padding-bottom: 36px` whether or not
 * anything rendered inside it. So a lander with no timeline still pays 72px.
 *
 * Measured on the live site, only the Coconut Reset carries `timeline`,
 * `mechanism`, `ingredient_cards`, `stats` and `founder_note` data. On the other
 * FOUR landers all five are empty, plus `compare-rows` — SIX consecutive empty
 * padded wrappers, ~432px of nothing between "What's NOT in any bottle or jar"
 * and the FAQ. That is the "giant open space", and it is on every bundle lander
 * but one.
 *
 * `whats-in-it` has the identical flaw and is included: `hand-soap-set` carries
 * no `value_stack` rows on any variant, so its "What's in the box" renders as
 * empty padding too.
 *
 * ── THE FIX, AND WHY IT IS CSS AND NOT LIQUID ───────────────────────────────
 * The wrapper belongs to the theme's section, so Liquid inside the section
 * cannot remove it — the markup is already open by the time this code runs. The
 * section CAN, however, address itself: `#shopify-section-{{ section.id }}`.
 * A `display:none` on that ID collapses the wrapper and its padding completely.
 *
 * The guard is PREPENDED rather than spliced into the existing `{%- if -%}`.
 * Those conditionals differ per section (some test `.size`, some test a bare
 * string, one runs a loop over variants), and rewriting six of them by hand is
 * six chances to invert a condition and blank a section that has data. Prepending
 * is additive: the worst a mistake can do is fail to hide something.
 *
 * The specificity is safe without `!important` — an ID selector beats the theme's
 * class rules, and this `<style>` renders after the theme's own `data-shopify`
 * block for the same ID.
 *
 * ── IT ONLY WRITES `theme/` ─────────────────────────────────────────────────
 * Uploading is a separate, reviewed step against a PREVIEW theme, per the
 * operator's standing rule: work offline until the change is approved, never
 * test on the live theme.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = 'theme/templates/product.bundle-landing.json';

/** Present when a section has already been guarded, so a re-run is a no-op. */
export const MARKER = 'empty-section-guard';

/**
 * section key -> the Liquid expression holding the data it needs.
 * `null` means "emptiness is not a single expression" and is handled below.
 */
export const SECTION_DATA = Object.freeze({
  timeline: 'product.metafields.bundle.lander.value.timeline.value',
  mechanism: 'product.metafields.bundle.lander.value.mechanism.value',
  'ingredient-cards': 'product.metafields.bundle.lander.value.ingredient_cards.value',
  stats: 'product.metafields.bundle.lander.value.stats.value',
  'compare-rows': 'product.metafields.bundle.comparison_rows.value',
  'founder-note': 'product.metafields.bundle.lander.value.founder_note',
  'collapsible-content': 'product.metafields.bundle.lander.value.faq.value',
  // No `hook` entry: that section was removed from the template outright, and a
  // guard for a section that does not exist reads like coverage it is not.
  'whats-in-it': null,
});

/**
 * `whats-in-it` is empty when NO variant carries a value_stack, which is a loop
 * rather than an expression — the same test the section's own body already runs.
 */
export const WHATS_IN_IT_GUARD = `{%- comment -%}${MARKER}{%- endcomment -%}`
  + '{%- assign _guard_stack = false -%}'
  + '{%- for v in product.variants -%}{%- if v.metafields.bundle.value_stack.value -%}{%- assign _guard_stack = true -%}{%- endif -%}{%- endfor -%}'
  + '{%- unless _guard_stack -%}<style>#shopify-section-{{ section.id }}{display:none}</style>{%- endunless -%}';

/** @returns {string} the guard to prepend for a section backed by one expression */
export function guardFor(expr) {
  return `{%- comment -%}${MARKER}{%- endcomment -%}`
    + `{%- assign _guard = ${expr} -%}`
    + '{%- if _guard == blank or _guard.size == 0 -%}'
    + '<style>#shopify-section-{{ section.id }}{display:none}</style>'
    + '{%- endif -%}';
}

/**
 * @returns {{changed:string[], skipped:string[], missing:string[], json:object}}
 */
export function applyGuards(template, data = SECTION_DATA) {
  const json = JSON.parse(template);
  const changed = [], skipped = [], missing = [];
  for (const [key, expr] of Object.entries(data)) {
    const sec = json.sections?.[key];
    if (!sec || typeof sec.settings?.custom_liquid !== 'string') { missing.push(key); continue; }
    if (sec.settings.custom_liquid.includes(MARKER)) { skipped.push(key); continue; }
    const guard = expr === null ? WHATS_IN_IT_GUARD : guardFor(expr);
    sec.settings.custom_liquid = guard + sec.settings.custom_liquid;
    changed.push(key);
  }
  return { changed, skipped, missing, json };
}

async function main(argv) {
  const apply = argv.includes('--apply');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/hide-empty-lander-sections.mjs [--apply]');
    return 0;
  }
  const path = join(ROOT, TEMPLATE);
  let src;
  try { src = readFileSync(path, 'utf8'); } catch { console.error(`cannot read ${TEMPLATE}`); return 1; }

  const { changed, skipped, missing, json } = applyGuards(src);
  for (const k of changed) console.log(`  GUARD    ${k}`);
  for (const k of skipped) console.log(`  ALREADY  ${k}`);
  for (const k of missing) console.log(`  ABSENT   ${k} (not a custom_liquid section in this template)`);

  if (!changed.length) { console.log('\nnothing to do.'); return 0; }
  if (!apply) { console.log(`\n${changed.length} section(s) would be guarded. Re-run with --apply.`); return 0; }

  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`\nwrote ${TEMPLATE} (${changed.length} guarded).`);
  console.log('This script NEVER uploads. Push to a PREVIEW theme and look at the page before publishing.');
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
