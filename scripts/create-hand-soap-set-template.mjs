#!/usr/bin/env node
/**
 * Give the Hand Soap Set its own product template, differing from the default
 * PDP in exactly one setting.
 *
 *   node scripts/create-hand-soap-set-template.mjs [--apply]
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * `sections/main-product.liquid` gates the whole variant-scoping branch on
 * `section.settings.hide_variants == false`. On `templates/product.json` — the
 * default PDP, which the Hand Soap Set uses — it is TRUE, so the theme never
 * looks at the alt-text suffix and every gallery image shows for every variant.
 * On a product with 15 variants at three prices that means a buyer choosing the
 * $44 configuration is shown a frame reading $72.
 *
 * ── Why not just flip it on templates/product.json ──────────────────────────
 * That template is shared by every ordinary PDP, and those products DO attach
 * images to variants. `hide_variants` is what keeps their galleries showing only
 * the selected variant's photo; turning it off would dump every scent's photo
 * into every one of those galleries at once. The blast radius is the entire
 * catalogue to fix one product.
 *
 * ── Why not move it to bundle-landing ───────────────────────────────────────
 * That is the better long-term home — it is a bundle, and the lander's
 * per-variant value panel and "What's in the box" grid are metafield-driven and
 * would handle all 15 combinations exactly, without needing the gang convention
 * at all. But it requires a `bundle_lander` metaobject this product does not
 * have: heading, subheading, CTA label, bullets, buybox bullets, FAQ and tabs.
 * That is customer-facing positioning copy, not a mechanical migration, so it is
 * recorded as the follow-up rather than invented here.
 *
 * So: a copy of the default PDP with one setting changed. Smallest change that
 * makes the gallery work, and reversible by deleting the template and clearing
 * templateSuffix.
 *
 * Safe for this product specifically because it has NO variant-attached media —
 * all ten frames are product-level — so `hide_variants` has no effect on it
 * beyond ungating the branch. The script verifies that before writing.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shopifyGraphQL, getMainThemeId, getThemeAsset, updateThemeAsset } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const HANDLE = 'hand-soap-set';
const SUFFIX = 'hand-soap-set';
const KEY = `templates/product.${SUFFIX}.json`;

const product = (await shopifyGraphQL(`{ productByHandle(handle:"${HANDLE}"){ id title templateSuffix
  media(first:100){ nodes{ ... on MediaImage { id } } }
  variants(first:50){ nodes{ id title media(first:5){ nodes{ id } } } } } }`)).productByHandle;
if (!product) throw new Error(`no product with handle ${HANDLE}`);

// If any media is attached to a variant, flipping hide_variants changes what the
// gallery shows for reasons that have nothing to do with our frames.
const attached = product.variants.nodes.filter((v) => v.media.nodes.length);
if (attached.length) {
  console.error(`Refusing: ${attached.length} variant(s) have media attached (${attached.map((v) => v.title).join(', ')}).`);
  console.error('hide_variants governs how those are displayed, so turning it off is not a no-op here.');
  process.exit(1);
}
console.log(`${product.title}: ${product.media.nodes.length} media, none attached to a variant ✓`);
console.log(`current templateSuffix: ${product.templateSuffix ?? '(default)'}`);

const themeId = await getMainThemeId();
const base = await getThemeAsset(themeId, 'templates/product.json');
const tpl = JSON.parse(base);
const mainKey = Object.keys(tpl.sections).find((k) => tpl.sections[k].type === 'main-product');
if (!mainKey) throw new Error('templates/product.json has no main-product section');

const before = tpl.sections[mainKey].settings?.hide_variants;
tpl.sections[mainKey].settings = { ...(tpl.sections[mainKey].settings ?? {}), hide_variants: false };
console.log(`\n${KEY}: main-product hide_variants ${JSON.stringify(before)} → false`);

// Confirm nothing else differs from the default PDP.
const diff = JSON.stringify(JSON.parse(base)) === JSON.stringify(tpl)
  ? '(none)'
  : 'hide_variants only';
console.log(`differences from templates/product.json: ${diff}`);

mkdirSync(join(ROOT, 'data', 'backups', 'theme'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'backups', 'theme', 'product.json.at-hand-soap-set-template.json'), base);

const out = JSON.stringify(tpl, null, 2);
JSON.parse(out);

if (!APPLY) { console.log('\ndry run — pass --apply'); process.exit(0); }

await updateThemeAsset(themeId, KEY, out);
console.log(`✓ wrote ${KEY}`);

const r = await shopifyGraphQL(`mutation{ productUpdate(input:{id:"${product.id}", templateSuffix:"${SUFFIX}"}){
  product{ templateSuffix } userErrors{ field message } } }`);
if (r.productUpdate.userErrors.length) { console.error(JSON.stringify(r.productUpdate.userErrors)); process.exit(1); }
console.log(`✓ ${HANDLE} templateSuffix → ${r.productUpdate.product.templateSuffix}`);
