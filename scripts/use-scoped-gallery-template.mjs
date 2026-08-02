#!/usr/bin/env node
/**
 * Put a product on the shared "scoped gallery" template.
 *
 *   node scripts/use-scoped-gallery-template.mjs <handle> [<handle>...] [--apply]
 *
 * ── Why this template exists ────────────────────────────────────────────────
 * `sections/main-product.liquid` gates all variant scoping on
 * `section.settings.hide_variants == false`. On `templates/product.json` — the
 * default PDP — it is TRUE, so every '#' suffix is inert and every gallery image
 * shows for every variant. Silently: the upload succeeds, the scope script
 * reports success, the CDN returns 200, and the page is wrong.
 *
 * Flipping it on `templates/product.json` is not an option: every ordinary PDP
 * shares it and those products DO attach images to variants, so `hide_variants`
 * is what stops their galleries showing every scent at once.
 *
 * The Hand Soap Set got a bespoke `product.hand-soap-set.json` for this. The
 * Deodorant 4-Pack needs exactly the same thing, and so will the Toothpaste
 * 3-Pack and the Bar Soap 4-Pack — every replenishment bundle is a
 * multi-variant PDP whose gallery should follow the variant. One template
 * shared by all of them beats four identical copies drifting apart, so this
 * script supersedes create-hand-soap-set-template.mjs and migrates it too.
 *
 * ── The one safety condition ────────────────────────────────────────────────
 * `hide_variants` also governs how variant-ATTACHED media are displayed. Turning
 * it off is a no-op only for products with none. Checked per product, refused
 * per product.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shopifyGraphQL, getMainThemeId, getThemeAsset, updateThemeAsset } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const handles = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!handles.length) { console.error('usage: use-scoped-gallery-template.mjs <handle> [<handle>...] [--apply]'); process.exit(2); }

const SUFFIX = 'scoped-gallery';
const KEY = `templates/product.${SUFFIX}.json`;
const themeId = await getMainThemeId();

// ── Build the template from the current default PDP ────────────────────────
const base = await getThemeAsset(themeId, 'templates/product.json');
const tpl = JSON.parse(base);
const mainKey = Object.keys(tpl.sections).find((k) => tpl.sections[k].type === 'main-product');
if (!mainKey) throw new Error('templates/product.json has no main-product section');
const before = tpl.sections[mainKey].settings?.hide_variants;
tpl.sections[mainKey].settings = { ...(tpl.sections[mainKey].settings ?? {}), hide_variants: false };
console.log(`${KEY}: main-product hide_variants ${JSON.stringify(before)} → false (only difference from the default PDP)\n`);

// ── Check every product before touching anything ───────────────────────────
const ok = [];
for (const handle of handles) {
  const p = (await shopifyGraphQL(`{ productByHandle(handle:"${handle}"){ id title templateSuffix
    options{ name values }
    variants(first:100){ nodes{ id title media(first:5){ nodes{ id } } } } } }`)).productByHandle;
  if (!p) { console.error(`✗ ${handle}: no such product`); process.exit(1); }
  const attached = p.variants.nodes.filter((v) => v.media.nodes.length);
  const variants = p.options.reduce((n, o) => n * o.values.length, 1);
  if (attached.length) {
    console.error(`✗ ${handle}: ${attached.length} variant(s) have media ATTACHED (${attached.map((v) => v.title).join(', ')}).`);
    console.error('   hide_variants governs how those display, so turning it off is not a no-op here.');
    process.exit(1);
  }
  if (variants < 2) {
    console.error(`✗ ${handle}: only ${variants} variant — there is nothing to scope, so it does not need this template.`);
    process.exit(1);
  }
  console.log(`✓ ${handle.padEnd(28)} ${variants} variants, no attached media, currently on ${p.templateSuffix ?? '(default)'}`);
  ok.push(p);
}

mkdirSync(join(ROOT, 'data', 'backups', 'theme'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'backups', 'theme', 'product.json.at-scoped-gallery.json'), base);

const out = JSON.stringify(tpl, null, 2);
JSON.parse(out);
if (!APPLY) { console.log('\ndry run — pass --apply'); process.exit(0); }

await updateThemeAsset(themeId, KEY, out);
console.log(`\n✓ wrote ${KEY}`);
for (const p of ok) {
  const r = await shopifyGraphQL(`mutation{ productUpdate(input:{id:"${p.id}", templateSuffix:"${SUFFIX}"}){
    product{ handle templateSuffix } userErrors{ field message } } }`);
  if (r.productUpdate.userErrors.length) { console.error(JSON.stringify(r.productUpdate.userErrors)); process.exit(1); }
  console.log(`✓ ${r.productUpdate.product.handle} → ${r.productUpdate.product.templateSuffix}`);
}
