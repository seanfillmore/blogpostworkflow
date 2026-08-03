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
 *     "option": "Scent",                                  // default for bare strings
 *     "scope": {
 *       "<filename fragment>": "<option value>",          // uses the default option
 *       "<fragment>": { "option": "Configuration", "value": "4 pumps" }   // or its own
 *     }
 *   }
 *
 * The second form exists for products with more than one option. A media can be
 * scoped to exactly ONE option/value pair — the theme parses `gang_option_name`
 * from that media's own suffix — so on the Hand Soap Set (Configuration x Scent)
 * the count and the scent are carried by DIFFERENT frames, each scoped to its own
 * option. Both must live in ONE scope file: a media absent from `scope` has its
 * suffix stripped, so a second run would silently unscope the first run's work.
 *
 * Keyed on a fragment of the image filename because that is stable, readable in a
 * diff, and survives re-uploads in a way media IDs do not. Anything not listed is
 * left unscoped on purpose.
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken, getMainThemeId, getThemeAsset } from '../lib/shopify.js';

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
  `query($h:String!){ productByHandle(handle:$h){ id title templateSuffix
     options { name values }
     media(first:100){edges{node{ id ... on MediaImage { alt image { url } } }}} } }`,
  { h: cfg.product },
)).productByHandle;
if (!product) throw new Error(`no product with handle ${cfg.product}`);

// ── The precondition this file has documented since it was written, and never
// ── actually checked.
//
// sections/main-product.liquid gates the ENTIRE gang branch on
// `section.settings.hide_variants == false`. Where it is true the theme never
// looks at the '#' suffix, so scoping is inert: every media shows for every
// variant and nothing anywhere reports a problem.
//
// That is not hypothetical. The Hand Soap Set sits on the default PDP template,
// where hide_variants is TRUE, and this script cheerfully wrote eight scope
// suffixes that could never take effect — a $72 frame showing to someone buying
// the $44 configuration. Settings are per TEMPLATE, so the check has to follow
// the product's own templateSuffix rather than assume bundle-landing.
{
  const key = `templates/product${product.templateSuffix ? `.${product.templateSuffix}` : ''}.json`;
  const themeId = await getMainThemeId();
  let tpl;
  try {
    tpl = JSON.parse(await getThemeAsset(themeId, key));
  } catch (e) {
    throw new Error(`could not read ${key} to check hide_variants: ${e.message}`);
  }
  const main = Object.values(tpl.sections ?? {}).find((s) => s.type === 'main-product');
  if (!main) throw new Error(`${key} has no main-product section — cannot verify hide_variants`);
  if (main.settings?.hide_variants !== false) {
    console.error(`Refusing: ${key} has main-product hide_variants = ${JSON.stringify(main.settings?.hide_variants)}.`);
    console.error('The theme gates the whole variant-scoping branch on that being false, so every suffix');
    console.error('written here would be inert — each image would show for EVERY variant, silently.');
    console.error(`\nEither set hide_variants:false on that template, or give ${cfg.product} its own template.`);
    process.exit(1);
  }
  console.log(`${key}: hide_variants = false ✓`);
}

/**
 * A scope entry is either a bare value string, which uses the file-level
 * `option`, or `{ "option": "...", "value": "..." }` for products with more than
 * one option.
 *
 * The Hand Soap Set is why the second form exists. It has TWO options —
 * Configuration (4 pumps / 3 pumps + body lotion / 4 pumps + body lotion) and
 * Scent (Variety + four scents) — and the theme's convention scopes a media to
 * exactly ONE option/value pair: `gang_option_name` is parsed from that media's
 * own alt suffix and matched against whichever product option shares the name.
 * There is no way to say "this image is for 4 pumps AND Orange Zest".
 *
 * Two runs of this script cannot substitute, because a media absent from `scope`
 * has its suffix STRIPPED (`wanted = baseAlt`) — so a second pass scoping the
 * Scent frames would silently unscope the Configuration ones. One file has to
 * describe every scoped media, which means entries need their own option.
 */
function resolveEntry(raw) {
  const value = typeof raw === 'string' ? raw : raw?.value;
  const optionName = typeof raw === 'string' ? cfg.option : (raw?.option ?? cfg.option);
  if (!value) throw new Error(`scope entry ${JSON.stringify(raw)} has no value`);
  if (!optionName) throw new Error(`scope entry ${JSON.stringify(raw)} names no option, and the file sets no default "option"`);
  const opt = product.options.find((o) => o.name === optionName);
  if (!opt) {
    throw new Error(`product has no option named "${optionName}" — it has: ${product.options.map((o) => o.name).join(', ')}`);
  }
  // A suffix naming a value that does not exist matches no variant, and the
  // theme's CSS then hides that image for ALL of them — a silent disappearance
  // rather than a visible error.
  if (!opt.values.includes(value)) {
    throw new Error(`"${value}" is not a value of option "${opt.name}" — it has: ${opt.values.join(', ')}`);
  }
  return { optionHandle: handleize(opt.name).replace(/_/g, '-'), value, optionName: opt.name };
}

const resolved = Object.fromEntries(Object.entries(cfg.scope).map(([frag, raw]) => [frag, resolveEntry(raw)]));

console.log(`${product.title}  (${cfg.product})`);
for (const o of product.options) {
  const used = Object.values(resolved).filter((r) => r.optionName === o.name).length;
  if (used) console.log(`option "${o.name}" → handle "${handleize(o.name).replace(/_/g, '-')}", scoping ${used} media, values: ${o.values.join(', ')}`);
}
console.log();

const updates = [];
for (const edge of product.media.edges) {
  const node = edge.node;
  if (!node.image) continue;
  const filename = decodeURIComponent(node.image.url.split('/').pop().split('?')[0]);
  const match = Object.keys(resolved).find((frag) => filename.includes(frag));
  const baseAlt = (node.alt ?? '').split('#')[0];
  const wanted = match
    ? `${baseAlt}#${resolved[match].optionHandle}_${handleize(resolved[match].value)}`
    : baseAlt;

  const state = match ? `${resolved[match].optionName} = ${resolved[match].value}` : 'all variants';
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
  return Object.keys(resolved).some((frag) => f.includes(frag));
});
const stranded = order.slice(firstScoped + 1).filter((n) => {
  const f = decodeURIComponent(n.image.url.split('/').pop().split('?')[0]);
  return !Object.keys(resolved).some((frag) => f.includes(frag));
});
if (firstScoped !== -1 && stranded.length) {
  console.error('\nRefusing: these media are unscoped but sit after a scoped one, so the theme');
  console.error('will hide them for EVERY variant (gang_exist is sticky across the media loop):');
  for (const n of stranded) console.error(`  ${decodeURIComponent(n.image.url.split('/').pop().split('?')[0])}`);
  console.error('\nGive each one a scope entry — duplicate the asset per option value if it is');
  console.error('genuinely true of all of them — or move it before every scoped media.');
  process.exit(1);
}

// ── The lead media decides whether the MAIN image ever changes ──────────────
// The gallery shows the first media that is not hidden. An unscoped media is
// never hidden, so if the first media is unscoped it is the main image for every
// variant — the buyer changes their selection and the big picture does not move.
//
// This is in direct tension with the guard above, and the tension is real rather
// than a bug in either: an unscoped media is only SAFE first, but a media that is
// first and unscoped PINS the main image. On a multi-variant product you
// therefore have to choose, and scoping everything is almost always the answer —
// duplicating a universal frame once per option value costs three identical
// JPEGs.
//
// The Hand Soap Set shipped the other way round and Sean caught it on the
// storefront: "the main image does not change no matter what scent or
// configuration you choose." Warned rather than refused, because a fixed lead
// image is legitimate on a single-variant product or where the lead is
// deliberately universal.
if (order.length && Object.keys(resolved).length) {
  const firstName = decodeURIComponent(order[0].image.url.split('/').pop().split('?')[0]);
  const firstIsScoped = Object.keys(resolved).some((frag) => firstName.includes(frag));
  const variantCount = product.options.reduce((n, o) => n * o.values.length, 1);
  if (!firstIsScoped && variantCount > 1) {
    console.warn(`\n⚠️  The first media (${firstName}) is UNSCOPED, so it shows for all ${variantCount} variants`);
    console.warn('   and is therefore the main image for all of them — the big picture will not change when');
    console.warn('   the buyer picks an option. If it should, scope every media and lead with one scoped to');
    console.warn('   whichever option changes how the product looks.');
  }
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
