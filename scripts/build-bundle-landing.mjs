/**
 * Regenerate the literal-price settings in a bundle landing template from the
 * product's `bundle.value_stack` metafield.
 *
 *   node scripts/build-bundle-landing.mjs <product-handle> [--apply]
 *
 * WHY THIS EXISTS
 *   Shopify evaluates Liquid ONLY inside `custom_liquid` settings. Rich-text,
 *   multicolumn and heading settings render their value verbatim, so `{{ ... }}`
 *   in them is printed, not computed. Verified on this theme: the only settings
 *   containing Liquid are the three custom_liquid blocks.
 *
 *   So blocks that show a price and are not custom_liquid cannot compute it. That
 *   is exactly how the hero came to read "A complete $158 routine" while the buy
 *   box struck through $118 — the compare-at price was data and updated itself;
 *   the hero was a string and did not.
 *
 *   Rather than leave three literals to drift again, this regenerates them from
 *   the same metafield the computed blocks read. The metafield stays the single
 *   source of truth; these settings become generated output, like
 *   docs/bundle-economics.md. Do not hand-edit them in the theme editor — run
 *   this instead, or the next edit silently reintroduces the drift.
 *
 * Dry-run by default; pass --apply to push.
 */

import { shopifyGraphQL, getMainThemeId, getThemeAsset, updateThemeAsset } from '../lib/shopify.js';

const handle = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!handle) {
  console.error('usage: node scripts/build-bundle-landing.mjs <product-handle> [--apply]');
  process.exit(1);
}

const pr = await shopifyGraphQL(`{
  products(first:1, query:"handle:${handle}"){ nodes {
    id title templateSuffix
    priceRangeV2 { minVariantPrice { amount } }
    metafields(first:10, namespace:"bundle"){ nodes { key value } }
  } } }`);
const p = pr.products.nodes[0];
if (!p) { console.error(`no product with handle "${handle}"`); process.exit(1); }

const mf = Object.fromEntries(p.metafields.nodes.map(m => [m.key, m.value]));
if (!mf.value_stack) { console.error(`${handle} has no bundle.value_stack metafield — nothing to generate from`); process.exit(1); }

const stack = JSON.parse(mf.value_stack);
const days = Number(mf.duration_days || 90);
const price = Math.round(Number(p.priceRangeV2.minVariantPrice.amount));
const total = stack.reduce((s, r) => s + Number(r.amount), 0);
const savings = total - price;

console.log(`${p.title}  (template: ${p.templateSuffix})`);
console.log(`  stack: ${stack.map(r => r.label + ' $' + r.amount).join(' + ')}`);
console.log(`  total $${total}  price $${price}  savings $${savings}  duration ${days}d\n`);

// GUARD: these settings live in the TEMPLATE, so if more than one product uses
// that template they cannot each hold their own prices. Writing here would push
// one bundle's numbers onto every other bundle sharing the template.
//
// Found the hard way building bundle #2: the Clean Swap ($213/$159) and the
// Reset ($158/$99) both use product.bundle-landing, and applying would have
// rewritten the live Reset's prices. Refuse rather than corrupt.
// `template_suffix:` is not a supported search field — it silently returns
// everything. Read templateSuffix off each product and filter in JS instead.
const sharers = await shopifyGraphQL(`{
  products(first:250){ nodes { handle title templateSuffix } } }`);
const others = sharers.products.nodes.filter(
  x => x.templateSuffix === p.templateSuffix && x.handle !== handle);
if (others.length) {
  console.error(`\nREFUSING: template "${p.templateSuffix}" is shared with ${others.length} other product(s):`);
  for (const o of others) console.error(`   ${o.handle}  (${o.title})`);
  console.error(`\nWriting ${handle}'s prices into it would overwrite theirs. Either give this`);
  console.error(`product its own template, or convert the price-displaying sections to`);
  console.error(`custom-liquid so they compute per product. See docs/bundle-landing-architecture.md.`);
  process.exit(1);
}

const key = `templates/product.${p.templateSuffix}.json`;
const themeId = await getMainThemeId();
const raw0 = await getThemeAsset(themeId, key);
const raw = typeof raw0 === 'string' ? raw0 : (raw0?.value ?? '');
const j = JSON.parse(raw);

// Settings that display a price but cannot evaluate Liquid. Each carries
// substitutions that rewrite ONLY the price tokens — the prose is human-authored
// and must survive untouched. An earlier version rebuilt whole sentences and
// would have silently replaced the copy; regenerate numbers, never wording.
const generated = [
  {
    path: ['hero', 'blocks', 'bullet-2', 'settings', 'text_rte'],
    subs: [
      [/A complete \$\d+(?:,\d{3})? routine/, `A complete $${total} routine`],
      [/yours for \$\d+(?:,\d{3})?/,          `yours for $${price}`],
    ],
  },
  {
    path: ['stats-row', 'blocks', 'stat-3', 'settings', 'title'],
    subs: [[/^\$\d+(?:,\d{3})?$/, `$${total}`]],
  },
  {
    path: ['final-cta-strip', 'blocks', 'fc-text', 'settings', 'text'],
    subs: [[/\$\d+(?:,\d{3})? value, \$\d+(?:,\d{3})? today/, `$${total} value, $${price} today`]],
  },
];

let changed = 0;
for (const g of generated) {
  let node = j.sections;
  for (const seg of g.path.slice(0, -1)) {
    node = node?.[seg];
    if (!node) break;
  }
  const leaf = g.path[g.path.length - 1];
  if (!node || node[leaf] === undefined) {
    console.log(`  SKIP  ${g.path.join('.')} — not present in this template`);
    continue;
  }
  const before = String(node[leaf]);
  let after = before;
  for (const [re, rep] of g.subs) after = after.replace(re, rep);

  if (after === before) { console.log(`  ok    ${g.path.join('.')}`); continue; }
  console.log(`  FIX   ${g.path.join('.')}`);
  console.log(`        was: ${before.slice(0, 120)}`);
  console.log(`        now: ${after.slice(0, 120)}`);
  node[leaf] = after;
  changed++;
}

if (!changed) { console.log('\nnothing to change.'); process.exit(0); }

if (!APPLY) {
  console.log(`\n${changed} setting(s) would change. Re-run with --apply to push.`);
  process.exit(0);
}

await updateThemeAsset(themeId, key, JSON.stringify(j, null, 2));
console.log(`\npushed ${changed} change(s) to ${key} on theme ${themeId}`);
