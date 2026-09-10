#!/usr/bin/env node
/**
 * One-off sweep: remove petrolatum / dimethicone / mineral oil / petroleum jelly from
 * the live landing-page templates, and the disease nouns from the sensitive-skin set.
 *
 * Operator ruling, Sean 2026-09-09: "I have never heard a human being say petrolatum
 * or dimethicone" → "Do not use those words." That supersedes the earlier carve-out
 * for the mechanistic-contrast shape: if we never name the ingredient, there is no
 * version of the claim left to defend.
 *
 * IT REWRITES RAW TEXT, NEVER JSON.parse → JSON.stringify. `templates/*.json` carry
 * escaped `<\/p>` sequences, and re-serializing normalizes every one of them — the
 * diff becomes hundreds of lines and the review gate is defeated. Exact string swaps
 * on the raw file keep the diff to the lines that actually changed.
 *
 * Every replacement is asserted to occur EXACTLY the expected number of times. A
 * miss aborts the whole file rather than writing a partial sweep.
 *
 * Usage: node scripts/sweep-theme-ingredient-names.mjs [--apply]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = (n) => join(ROOT, 'theme', 'templates', `product.${n}.json`);

/** [file, [ [before, after, expectedCount], … ] ] */
export const EDITS = [
  ['landing-page-lotion', [
    ['Six ingredients.<\\/strong> No mineral oil, no petrolatum, no synthetic fragrance — none of the filler most commercial lotions are mostly made of.',
      'Six ingredients.<\\/strong> No synthetic fragrance, no parabens, no filler — you can read the whole list and recognize every line of it.', 1],
    ["That's why this lotion isn't greasy. Mineral oil and dimethicone are cheaper and form a more uniform film. They also seal everything else underneath them.",
      "That's why this lotion isn't greasy. The cheaper bases most lotions are built on form a more uniform film, and seal everything else underneath them.", 1],
    ['<ul><li>No mineral oil or petroleum jelly. That&#39;s the cheap base most lotions are built on.<\\/li>',
      '<ul><li>No cheap filler base — the stuff most lotions are mostly made of.<\\/li>', 1],
    ['bottle after bottle of mineral oil, undisclosed fragrance, and parabens, marketed as nourishing.',
      'bottle after bottle of undisclosed fragrance and parabens, marketed as nourishing.', 1],
    ['Mineral oil and petrolatum — the cheap moisturizing bases in most commercial lotion — sit on top of skin and can trap debris underneath.',
      'The cheap moisturizing bases in most commercial lotion sit on top of skin and can trap debris underneath.', 1],
    // Not an ingredient name — a DISEASE noun on a commercial page. The fact is true
    // and worth keeping (fragrance genuinely is the leading cause of cosmetic skin
    // allergy); only the clinical noun goes.
    ['Synthetic fragrance is the leading cause of contact dermatitis in personal-care products.',
      'Synthetic fragrance is the leading cause of allergic skin reactions to personal-care products.', 1],
  ]],
  ['landing-page-cream', [
    ['Coconut oil and jojoba soak in. Petroleum jelly just sits there.',
      'Coconut oil and jojoba soak in. A cheap barrier base just sits there.', 1],
    ['No petroleum jelly, no mineral oil, no silicones, no lanolin.',
      'No silicones, no lanolin, no synthetic fragrance, no parabens.', 1],
    ['locks moisture in without sealing pores the way petrolatum does',
      'locks moisture in without sealing pores shut', 1],
    ['Petrolatum is cheaper and shelf-stable forever — it also fully occludes. We pay more for beeswax.',
      'Cheap barrier waxes are shelf-stable forever and fully occlusive. We pay more for beeswax.', 1],
    ['<ul><li>No petroleum jelly<\\/li><li>No mineral oil<\\/li><li>No silicones<\\/li>',
      '<ul><li>No silicones<\\/li>', 1],
    ['still relied on petrolatum, dimethicone, or undisclosed fragrance',
      'still relied on cheap fillers, silicones, or undisclosed fragrance', 1],
    ['Why use beeswax instead of petrolatum?', 'Why use beeswax as the barrier?', 1],
    ['<p>Petrolatum is the petroleum-derived occlusive that seals skin without feeding it — cheap, shelf-stable forever, and fully occlusive. Beeswax forms a breathable barrier instead.',
      '<p>The usual barrier waxes seal skin without feeding it — cheap, shelf-stable forever, and fully occlusive. Beeswax forms a breathable barrier instead.', 1],
  ]],
  ['landing-page-lip-balm', [
    ['No petroleum jelly, no lanolin, no added flavor, no menthol.',
      'No lanolin, no added flavor, no menthol, no parabens.', 1],
    ['<strong>No petroleum jelly, no lanolin, no synthetic flavoring.<\\/strong> The chronic-chap problem we usually trace to one of those three ingredients.',
      '<strong>No lanolin, no synthetic flavoring, no numbing agents.<\\/strong> The chronic-chap problem we usually trace to one of those three.', 1],
    ['Firmer than a petrolatum-based balm because beeswax sets harder than petroleum wax.',
      'Firmer than a drugstore balm because beeswax sets harder than the waxes they use.', 1],
    ['holds moisture in without occluding the way petrolatum does',
      'holds moisture in without sealing the lips shut', 1],
    ['Petrolatum and microcrystalline wax are cheaper and more occlusive — we chose beeswax because the lips can still exchange.',
      'The waxes most balms use are cheaper and more occlusive — we chose beeswax because the lips can still exchange.', 1],
    ['Where petrolatum sits on top, virgin coconut oil absorbs and feeds.',
      'Where a barrier wax sits on top, virgin coconut oil absorbs and feeds.', 1],
    ['asking why petrolatum, paraffin, and undisclosed flavoring were in something',
      'asking why paraffin and undisclosed flavoring were in something', 1],
    ['<ul><li>No petroleum jelly<\\/li><li>No petroleum wax<\\/li><li>No mineral oil<\\/li><li>No lanolin<\\/li>',
      '<ul><li>No lanolin<\\/li>', 1],
    ['still contain petrolatum, paraffin, lanolin, or', 'still contain paraffin, lanolin, or', 1],
  ]],
  ['landing-page-deodorant', [
    ['Mineral oil and petroleum jelly are much cheaper and always the same, but they sit on the surface.',
      'The usual carrier bases are cheaper and always the same, but they sit on the surface.', 1],
  ]],
  ['bundle-landing', [
    ['no fragrance, parabens, or mineral oil', 'no fragrance, parabens, or silicones', 1],
    ['<li>Mineral oil or petroleum jelly<\\/li><li>Petrolatum<\\/li><li>Silicones<\\/li>',
      '<li>Silicones<\\/li>', 1],
  ]],
  ['landing-page-sensitive-skin-set-lander', [
    // ── the DISEASE removal (operator: "get rid of it") ──────────────────────
    // The whole faq-eczema block goes, heading and body. It named three conditions
    // in the heading of a page with a buy button, and its body ran
    // "Many of our customers with eczema, rosacea, or perioral dermatitis report
    // fewer reactions" — a testimonial-conveyed efficacy claim for a disease
    // population. Its own "We can't make medical claims" opener does not cure that;
    // disclaiming and then claiming is the pattern, not the fix. The FTC holds an
    // advertiser responsible for what an endorsement CONVEYS and the FDA reads
    // testimonials as evidence of intended use.
    ['"faq-eczema": {\n          "type": "collapsible_row",\n          "settings": {\n            "heading": "Will this work if I have eczema, rosacea, or perioral dermatitis?",\n            "row_content": "<p>We can\'t make medical claims and don\'t sell our products as treatments. What we can tell you: we built the set around what reactive skin most often doesn\'t tolerate — synthetic fragrance, parabens, mineral oil, dimethicone, lanolin. Many of our customers with eczema, rosacea, or perioral dermatitis report fewer reactions on this set than on conventional drugstore lotions. If you\'ve reacted to multiple products before, the lotion + cream pairing is the closest thing we offer to a clean-slate routine.<\\/p>",\n            "page": ""\n          }\n        },\n        ',
      '', 1],
    ['        "faq-eczema",\n', '', 1],

    // ── the INGREDIENT-NAME sweep ───────────────────────────────────────────
    ['<p>Built for skin that reacts to fragrance, parabens, and mineral oil<\\/p>',
      '<p>Built for skin that reacts to fragrance, parabens, and silicones<\\/p>', 1],
    ['"Built for skin that reacts to fragrance, parabens, mineral oil"',
      '"Built for skin that reacts to fragrance, parabens, silicones"', 1],
    ['No added fragrance, no petroleum jelly, no silicones, no lanolin.',
      'No added fragrance, no silicones, no lanolin, no parabens.', 1],
    // "No common irritants" is itself the irritant framing — the least supportable
    // shape, since the evidence says these are well tolerated. It states what we
    // leave out instead, which is true and claims nothing about anyone's skin.
    ['<strong>No common irritants.<\\/strong> No mineral oil, petrolatum, dimethicone, or lanolin. No parabens, phenoxyethanol, or synthetic fragrance.',
      '<strong>What we leave out.<\\/strong> No silicones or lanolin. No parabens, phenoxyethanol, or synthetic fragrance.', 1],
    ['the person whose skin reacts to fragrance, parabens, dimethicone, or mineral oil',
      'the person whose skin reacts to fragrance, parabens, or silicones', 1],
    ['<li>Mineral oil or petroleum jelly<\\/li><li>Petrolatum<\\/li><li>Silicones<\\/li>',
      '<li>Silicones<\\/li>', 1],
    ['fragrance-free, dye-free, no lanolin, no dimethicone',
      'fragrance-free, dye-free, no lanolin, no silicones', 1],
    ['"Petrolatum & mineral oil — occlusive but not breathable"',
      '"Heavy barrier bases — occlusive but not breathable"', 1],
    ['<p>No petrolatum or mineral oil<\\/p>', '<p>No heavy barrier bases<\\/p>', 1],
    ['<p>Petrolatum seals skin without feeding it. We use organic beeswax instead — breathable barrier, real ingredient.<\\/p>',
      '<p>A sealing barrier holds water in without feeding skin. We use organic beeswax instead — breathable, and a real ingredient.<\\/p>', 1],
    ['<p>No dimethicone<\\/p>', '<p>No silicones<\\/p>', 1],
    // Block IDs are internal keys, never rendered — renamed only so the file carries
    // the words nowhere at all. Both the definition and block_order move together.
    ['"row-petrolatum": {', '"row-barrier": {', 1],
    ['        "row-petrolatum",\n', '        "row-barrier",\n', 1],
    ['"row-dimethicone": {', '"row-silicones": {', 1],
    ['        "row-dimethicone",\n', '        "row-silicones",\n', 1],
  ]],
];

export function applyEdits(raw, edits, label) {
  let out = raw;
  for (const [before, after, expected] of edits) {
    const n = out.split(before).length - 1;
    if (n !== expected) {
      throw new Error(`${label}: expected ${expected} occurrence(s) of ${JSON.stringify(before.slice(0, 60))}…, found ${n}`);
    }
    out = out.split(before).join(after);
  }
  return out;
}

export function main() {
  const apply = process.argv.includes('--apply');
  for (const [name, edits] of EDITS) {
    const path = T(name);
    const raw = readFileSync(path, 'utf8');
    const next = applyEdits(raw, edits, name);
    JSON.parse(next); // refuse to write anything that is not valid JSON
    const left = (next.match(/petrolatum|dimethicone|mineral oil|petroleum jelly/gi) || []).length;
    console.log(`${name}: ${edits.length} edit(s), ${left} term(s) remaining`);
    if (left) throw new Error(`${name}: ${left} term(s) still present — edit table is incomplete`);
    if (apply) writeFileSync(path, next);
  }
  console.log(apply ? '\nwritten' : '\n(dry run — pass --apply)');
}

if (isDirectRun(import.meta.url)) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}
