#!/usr/bin/env node
/**
 * Derive a per-VARIANT value stack for every bundle-landing product.
 *
 *   node scripts/build-variant-value-stacks.mjs [handle] [--apply]
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The lander carried two boxes listing the same things. The top one read
 * `variant.metafields.bundle.contents` — a per-variant newline string, the only
 * place scents appeared. The bottom one read `product.metafields.bundle
 * .value_stack` — product-level JSON with the prices. Two hand-authored lists of
 * the same box, with nothing keying one to the other.
 *
 * They happened to line up row-for-row on four of the five landers. On the
 * Coconut Reset they did not, and both lists still had three rows:
 *
 *     contents                    value_stack
 *     3 x Body Lotion             3 Body Lotions + 3 Body Creams  $174
 *     3 x Body Cream              90-Day Routine & Tracker         $19
 *     2 x digital guides          Coconut Skincare Field Guide     $15
 *
 * Merging those positionally prints $174 against the lotion alone and $19
 * against the cream. Every row wrong, counts matching, nothing to flag it.
 *
 * So the merged box is not built by zipping the two lists. It is DERIVED:
 * config/bundles.json says which component product and which scent each variant
 * ships, and the component's own live Shopify price says what the row is worth.
 * The hand-authored product-level stack stops being a source of truth for
 * anything physical.
 *
 * ── The invariant that makes this safe ──────────────────────────────────────
 * sum(physical rows) must equal the variant's compareAtPrice, exactly. Verified
 * across all five landers and every variant before this script was written. A
 * mismatch means either a component repriced or the bundle's compare-at drifted,
 * and either way the page would be claiming a saving that is not real — so it
 * refuses to write rather than publishing the discrepancy.
 *
 * Digital rows (the Reset's two guides) have no component and no scent, so they
 * are carried over from the existing product-level stack and sit ON TOP of
 * compare-at. That is the documented $34 gap, not an error.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const token = await getAccessToken();
const gql = async (query, variables) => {
  const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 500));
  return j.data;
};

/**
 * Display label per component product. Deliberately the vocabulary the existing
 * stacks already used, so the merge is not also a copy rewrite — except the lip
 * balm, which two landers disagreed about ("Lip Balm" vs "Lip Balm 4-pack"). The
 * SKU is "Natural Coconut Oil Lip Balm | 0.15oz | Four Pack", so one unit really
 * is four tubes and the longer label is the true one.
 */
const LABEL = {
  'coconut-lotion': 'Body Lotion (8oz)',
  'coconut-moisturizer': 'Body Cream (4oz)',
  'coconut-oil-deodorant': 'Natural Deodorant',
  'coconut-oil-toothpaste': 'Coconut Toothpaste',
  'coconut-soap': 'Coconut Bar Soap',
  'coconut-oil-lip-balm': 'Lip Balm (4-pack)',
  'organic-foaming-hand-soap': 'Foaming Hand Soap',
};

/**
 * Cutout naming, matching data/brand/cutouts/component-<slug>.png.
 *
 * The row carries the slug so the "What's in the box" grid can show the unit the
 * buyer actually receives. It used to render `component.featured_image` — the
 * component PRODUCT's primary image — which is variant-blind: the Head-to-Toe
 * grid showed a Coconut Breeze lotion in the Pure Unscented kit, and a
 * Wildcrafted Frankincense deodorant that ships in neither kit.
 */
const KIND = {
  'coconut-lotion': 'lotion',
  'coconut-moisturizer': 'cream',
  'coconut-oil-deodorant': 'deodorant',
  'coconut-oil-toothpaste': 'toothpaste',
  'coconut-soap': 'soap',
  'coconut-oil-lip-balm': 'lipbalm',
  'organic-foaming-hand-soap': 'handsoap',
};
const slugOf = (c) => `${KIND[c.product]}-${c.variant.toLowerCase().replace(/\s+/g, '-')}`;

const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));

const all = (await gql(`{ products(first:250){ nodes{ id handle title templateSuffix
  metafields(first:20,namespace:"bundle"){ nodes{ key value } }
  variants(first:30){ nodes{ id title price compareAtPrice } } } } }`)).products.nodes;

const priceOf = {};
for (const p of all) priceOf[p.handle] = Object.fromEntries(p.variants.nodes.map((v) => [v.title, Number(v.price)]));

const landers = all.filter((p) => p.templateSuffix === 'bundle-landing' && (!only || p.handle === only));
if (!landers.length) { console.error(`no bundle-landing product${only ? ` with handle "${only}"` : ''}`); process.exit(1); }

const backup = {};
const writes = [];
let problems = 0;

for (const p of landers) {
  const b = bundles.find((x) => x.handle === p.handle);
  if (!b) { console.error(`${p.handle}: not in config/bundles.json`); problems++; continue; }
  const mf = Object.fromEntries(p.metafields.nodes.map((m) => [m.key, m.value]));
  const productStack = mf.value_stack ? JSON.parse(mf.value_stack) : [];
  const digital = productStack.filter((r) => r.digital);

  console.log(`\n${'='.repeat(74)}\n${p.title}  (${p.handle})`);
  backup[p.handle] = { productValueStack: productStack, variants: {} };

  for (const v of b.variants) {
    const name = Object.values(v.options)[0];
    const live = p.variants.nodes.find((x) => x.title === name);
    if (!live) { console.error(`  ${name}: no live variant with that title`); problems++; continue; }

    const rows = [];
    let sum = 0;
    for (const c of v.components) {
      const label = LABEL[c.product];
      const unit = priceOf[c.product]?.[c.variant];
      if (!label) { console.error(`  no display label for component product "${c.product}"`); problems++; continue; }
      if (unit === undefined) { console.error(`  no live price for ${c.product} / ${c.variant}`); problems++; continue; }
      const amount = unit * c.qty;
      sum += amount;
      // `label` is qty-free and `qty` is its own field, so the two surfaces that
      // render these rows can compose the prefix differently: the value panel
      // shows it only above 1, the grid always shows it. Baking "3 × " into the
      // label would force one of them to string-parse it back out.
      // The row names the THEME ASSET (.webp, written by
      // scripts/upload-cutouts-to-theme.mjs), but existence is checked against the
      // repo master (.png) — that is the file a human can add, and the one whose
      // absence means the cutout was never made rather than never uploaded.
      const master = `component-${slugOf(c)}.png`;
      if (!existsSync(join(ROOT, 'data', 'brand', 'cutouts', master))) {
        console.error(`  no cutout for ${c.product} / ${c.variant} — expected data/brand/cutouts/${master}. `
          + 'Add a recipe to data/brand/cutouts/recipes.json and run scripts/rebuild-cutouts.mjs.');
        problems++;
        continue;
      }
      rows.push({ label, qty: c.qty, scent: c.variant, amount, img: `${master.slice(0, -4)}.webp` });
    }

    const compare = Number(live.compareAtPrice);
    if (sum !== compare) {
      console.error(`  ✗ ${name}: physical rows sum to $${sum} but compare-at is $${compare}. `
        + 'A component repriced or the bundle\'s compare-at drifted — the page would claim a saving that is not real.');
      problems++;
      continue;
    }

    const stack = [...rows, ...digital];
    backup[p.handle].variants[name] = { id: live.id, previousContents: null };
    writes.push({ ownerId: live.id, namespace: 'bundle', key: 'value_stack', type: 'json', value: JSON.stringify(stack) });

    const total = stack.reduce((a, r) => a + Number(r.amount), 0);
    console.log(`  ${name.padEnd(16)} ${rows.length} physical $${sum} = compare-at ✓`
      + `${digital.length ? ` + ${digital.length} digital $${total - sum}` : ''}  → total $${total}, price $${Math.round(live.price)}`);
    for (const r of stack) {
      const qty = r.qty > 1 ? `${r.qty} × ` : '';
      console.log(`      ${(qty + String(r.label)).padEnd(28)} ${(r.scent || (r.digital ? '(digital)' : '')).padEnd(20)} `
        + `$${String(r.amount).padEnd(4)} ${r.img || ''}`);
    }
  }
}

if (problems) { console.error(`\n✗ ${problems} problem(s) — refusing to write.`); process.exit(1); }

mkdirSync(join(ROOT, 'data', 'backups', 'products'), { recursive: true });
const backupPath = join(ROOT, 'data', 'backups', 'products', 'value-stacks-before-variant-merge.json');
writeFileSync(backupPath, JSON.stringify(backup, null, 2) + '\n');
console.log(`\nbacked up prior product-level stacks → ${backupPath.replace(ROOT + '/', '')}`);

if (!APPLY) { console.log(`\n${writes.length} variant value stacks to write — dry run, pass --apply`); process.exit(0); }

// metafieldsSet caps at 25 per call.
for (let i = 0; i < writes.length; i += 25) {
  const chunk = writes.slice(i, i + 25);
  const r = await gql(`mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{field message} } }`, { m: chunk });
  if (r.metafieldsSet.userErrors.length) { console.error(JSON.stringify(r.metafieldsSet.userErrors)); process.exit(1); }
}
console.log(`\n✓ wrote ${writes.length} per-variant value stacks`);
