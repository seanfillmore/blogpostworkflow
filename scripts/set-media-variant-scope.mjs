#!/usr/bin/env node
/**
 * Scope product media to specific variants, using this theme's alt-text convention.
 *
 *   node scripts/set-media-variant-scope.mjs <scope.json> [--apply]
 *
 * ── The convention ──────────────────────────────────────────────────────────
 * A Shopify variant holds exactly one media (see upload-product-images.mjs), so
 * variant *attachment* cannot scope a gallery of several frames. This theme does
 * it through alt text instead — verified in the live theme, not assumed:
 *
 *   sections/main-product.liquid
 *     if media.alt contains '#' and section.settings.hide_variants == false
 *       gang_connect = media.alt | split: '#' | last          → "scent_coconut-breeze"
 *       gang_option_name = gang_connect | split: '_' | first  → "scent"
 *       ... matches against option.name|handleize and option.selected_value|handleize
 *       if gang_connect == current_connect → class "gang__active"
 *     assign alt = media.alt | escape | split: '#' | first    → the visible alt
 *
 *   assets/section-main-product.css
 *     [data-gang-option] { display: none; }
 *     [data-gang-option].gang__active { display: block; }
 *
 * So the format is:
 *
 *   <real alt text>#<option-name-handle>_<option-value-handle>
 *
 * Media with no '#' carries no data-gang-option and therefore shows for every
 * variant — that is the correct state for anything universally true of the
 * product, like a review-proof frame.
 *
 * Two preconditions, both checked here rather than discovered on the storefront:
 *  - the section's `hide_variants` setting must be false, or the theme skips the
 *    whole branch and nothing is scoped;
 *  - the option name and value must actually exist on the product, or the suffix
 *    silently matches nothing and the image disappears for every variant.
 *
 * Scope file:
 *   {
 *     "product": "99-coconut-reset-digital",
 *     "option": "Scent",
 *     "scope": { "<filename fragment>": "<variant option value>", ... }
 *   }
 *
 * Keyed on a fragment of the image filename because that is stable, readable in a
 * diff, and survives re-uploads in a way media IDs do not. Anything not listed is
 * left unscoped on purpose.
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const argv = process.argv.slice(2);
const scopePath = argv.find((a) => !a.startsWith('--'));
const APPLY = argv.includes('--apply');
if (!scopePath) { console.error('usage: set-media-variant-scope.mjs <scope.json> [--apply]'); process.exit(2); }
const cfg = JSON.parse(readFileSync(resolve(scopePath), 'utf8'));

const gql = async (query, variables) => {
  const token = await getAccessToken();
  const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
};

/** Shopify's handleize: lowercase, non-alphanumerics to hyphens, collapsed and trimmed. */
const handleize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const product = (await gql(
  `query($h:String!){ productByHandle(handle:$h){ id title
     options { name values }
     media(first:100){edges{node{ id ... on MediaImage { alt image { url } } }}} } }`,
  { h: cfg.product },
)).productByHandle;
if (!product) throw new Error(`no product with handle ${cfg.product}`);

const option = product.options.find((o) => o.name === cfg.option);
if (!option) {
  throw new Error(`product has no option named "${cfg.option}" — it has: ${product.options.map((o) => o.name).join(', ')}`);
}
const optionHandle = handleize(option.name).replace(/_/g, '-');

// Every configured value must be a real option value. A suffix naming a value
// that does not exist matches no variant, and the theme's CSS then hides that
// image for ALL of them — a silent disappearance rather than a visible error.
for (const value of new Set(Object.values(cfg.scope))) {
  if (!option.values.includes(value)) {
    throw new Error(`"${value}" is not a value of option "${option.name}" — it has: ${option.values.join(', ')}`);
  }
}

console.log(`${product.title}  (${cfg.product})`);
console.log(`option "${option.name}" → handle "${optionHandle}", values: ${option.values.join(', ')}\n`);

const updates = [];
for (const edge of product.media.edges) {
  const node = edge.node;
  if (!node.image) continue;
  const filename = decodeURIComponent(node.image.url.split('/').pop().split('?')[0]);
  const match = Object.keys(cfg.scope).find((frag) => filename.includes(frag));
  const baseAlt = (node.alt ?? '').split('#')[0];
  const wanted = match ? `${baseAlt}#${optionHandle}_${handleize(cfg.scope[match])}` : baseAlt;

  const state = match ? cfg.scope[match] : 'all variants';
  if ((node.alt ?? '') === wanted) {
    console.log(`  ✓ ${filename.padEnd(42)} ${state}  (already correct)`);
    continue;
  }
  console.log(`  → ${filename.padEnd(42)} ${state}`);
  console.log(`      ${wanted.slice(Math.max(0, wanted.length - 96))}`);
  updates.push({ id: node.id, alt: wanted });
}

// ── The trap this guard exists for ──────────────────────────────────────────
// In sections/main-product.liquid, `gang_connect` is reset on every iteration of
// the media loop but `gang_exist` is NOT — it is assigned false once, before the
// loop, and only ever set true. So the moment one media is scoped, every media
// rendered AFTER it also gets `data-gang-option`, with an empty connect value it
// can never match. The CSS then hides it for every variant.
//
// This is silent: the image stays in the gallery in the admin, returns 200 from
// the CDN, and simply never renders. It cost the review frame a live disappearance
// before this check existed. An unscoped media is only safe if it sorts before
// every scoped one.
const order = product.media.edges.map((e) => e.node).filter((n) => n.image);
const firstScoped = order.findIndex((n) => {
  const f = decodeURIComponent(n.image.url.split('/').pop().split('?')[0]);
  return Object.keys(cfg.scope).some((frag) => f.includes(frag));
});
const stranded = order.slice(firstScoped + 1).filter((n) => {
  const f = decodeURIComponent(n.image.url.split('/').pop().split('?')[0]);
  return !Object.keys(cfg.scope).some((frag) => f.includes(frag));
});
if (firstScoped !== -1 && stranded.length) {
  console.error('\nRefusing: these media are unscoped but sit after a scoped one, so the theme');
  console.error('will hide them for EVERY variant (gang_exist is sticky across the media loop):');
  for (const n of stranded) console.error(`  ${decodeURIComponent(n.image.url.split('/').pop().split('?')[0])}`);
  console.error('\nGive each one a scope entry — duplicate the asset per option value if it is');
  console.error('genuinely true of all of them — or move it before every scoped media.');
  process.exit(1);
}

if (!updates.length) { console.log('\nnothing to change.'); process.exit(0); }
if (!APPLY) { console.log(`\n${updates.length} to update — dry run, pass --apply`); process.exit(0); }

const res = (await gql(
  `mutation($productId:ID!,$media:[UpdateMediaInput!]!){
     productUpdateMedia(productId:$productId, media:$media){
       media { ... on MediaImage { id alt } } mediaUserErrors { field message code } } }`,
  { productId: product.id, media: updates },
)).productUpdateMedia;
if (res.mediaUserErrors.length) throw new Error(JSON.stringify(res.mediaUserErrors));
console.log(`\nupdated ${res.media.length} media.`);
