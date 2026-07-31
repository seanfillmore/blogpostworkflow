#!/usr/bin/env node
/**
 * Task 6: Brand-query metadata (2026-07-27)
 *
 * Brand queries (`real skin care`, `realskincare`, variants) drew 9,723
 * impressions / 170 clicks over 90 days. The homepage takes only 1,290 of
 * those, at average position 4.5 — fourth for the company's own name,
 * behind several of the store's own pages.
 *
 * INVESTIGATION RESULT — read this before touching anything below.
 * ------------------------------------------------------------------
 * `layout/theme.liquid` on the live theme (gid://shopify/OnlineStoreTheme/
 * 147480051882) does NOT hardcode the homepage title or description. It only
 * emits the Liquid built-ins:
 *
 *   <title>
 *     {{ page_title }}
 *     ...
 *     {%- unless page_title contains shop.name %} &ndash; {{ shop.name }}{% endunless -%}
 *   </title>
 *
 *   {%- if page_description -%}
 *     <meta name="description" content="{{ page_description | escape }}">
 *   {%- endif -%}
 *
 * There is no theme-level fallback to `shop.description` either — if
 * `page_description` is blank, the tag is simply omitted. For the homepage,
 * Shopify populates `page_title` / `page_description` from the shop-level
 * "Title tag" / "Meta description" fields under
 * Admin > Online Store > Preferences (the shop's `global.title_tag` /
 * `global.description_tag` metafields). That is a SHOP-LEVEL SETTING, not a
 * theme asset, and this codebase's Shopify REST helpers (lib/shopify.js)
 * have no writer for it — `updateThemeAsset` only reaches theme files, and
 * the metafield helpers (`getMetafields`/`upsertMetafield`) are all called
 * against a `(resource, resourceId)` pair (pages/products/collections),
 * never against the shop resource itself.
 *
 * Evidence (live, confirmed 2026-07-27): curl of https://www.realskincare.com/
 * and https://www.realskincare.com/collections returns the IDENTICAL
 * 316-character meta description on both pages, and the homepage <title>
 * matches the brief's quoted string exactly:
 *
 *   Title:  "Coconut Oil Based Skin Care Products | Real Skin Care"
 *   Desc:   "We are confident that our skin care products are among the
 *            purest, cleanest, and most innovative natural blends available
 *            today. These incredible blends were not created in some
 *            chemical laboratory using harsh toxins and artificial
 *            preservatives, but rather they were discovered through careful
 *            complimentary design." (316 chars)
 *
 * /collections has no collection-specific description of its own, so it
 * falls back to the same shop-level field — which is why it serves the
 * identical string. Fixing the one shop setting fixes both pages.
 *
 * CONSEQUENCE: this script does not call `updateThemeAsset` and never will —
 * editing the theme would not change what ships, since the theme has no
 * hardcoded string to change. It also does not attempt any API write, even
 * with --apply: there is no `write_content`-scoped endpoint in this
 * codebase reaching shop-level SEO fields. Instead, it validates the
 * proposed copy, reports the current live metadata, and prints the exact
 * manual steps for Shopify Admin. That is the correct and complete outcome
 * per the task brief, not a shortfall.
 *
 * Usage:
 *   node scripts/fix-brand-metadata.mjs            # dry run (default)
 *   node scripts/fix-brand-metadata.mjs --apply     # still prints instructions only — see above
 */

const APPLY = process.argv.includes('--apply');

const SITE_URL = 'https://www.realskincare.com';

// NOTE ON COPY: the task brief's original "required copy" for DESCRIPTION
// was 196 characters — over its own 160-char limit, which is exactly the
// truncation defect this task exists to fix. The task coordinator confirmed
// on 2026-07-27 that the length constraint governs and the brief's copy was
// illustrative, not literal, and supplied this replacement (146 chars,
// verified by counting), which closes on the site's existing "reacts to
// everything else" hero line rather than inventing new voice. The title was
// already under budget and is unchanged from the brief.
const TITLE = 'Real Skin Care | Coconut Oil Skin Care for Sensitive Skin';
const DESCRIPTION =
  'Real Skin Care makes small-batch coconut-oil lotion, body cream, toothpaste, ' +
  'deodorant, soap and lip balm for skin that reacts to everything else.';

if (DESCRIPTION.length > 160) {
  throw new Error(`meta description is ${DESCRIPTION.length} chars, max 160`);
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function extractDescription(html) {
  const m = html.match(/<meta\s+name="description"\s+content="([\s\S]*?)"\s*\/?>/);
  return m ? m[1] : null;
}

async function fetchLiveMeta(path) {
  const res = await fetch(`${SITE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} -> HTTP ${res.status}`);
  }
  const html = await res.text();
  return { title: extractTitle(html), description: extractDescription(html) };
}

function printSection(heading) {
  console.log(`\n--- ${heading} ---`);
}

async function main() {
  console.log('=== Task 6: Brand-query metadata ===');

  printSection('Investigation result');
  console.log('Source: SHOP-LEVEL SETTING (Admin > Online Store > Preferences),');
  console.log('NOT a theme file. layout/theme.liquid only references the Liquid');
  console.log('built-ins `page_title` / `page_description`; no title or description');
  console.log('string is hardcoded in any theme asset. This script does not edit');
  console.log('the theme.');

  let home;
  let collections;
  try {
    [home, collections] = await Promise.all([
      fetchLiveMeta('/'),
      fetchLiveMeta('/collections'),
    ]);
  } catch (err) {
    console.error(`\nCould not fetch live pages to confirm current metadata: ${err.message}`);
    console.error('Proceeding to print the required manual change anyway.');
    home = { title: null, description: null };
    collections = { title: null, description: null };
  }

  printSection('Current live homepage (/)');
  console.log(`Title:              "${home.title ?? '(unavailable)'}"`);
  console.log(`Description length: ${home.description ? home.description.length : 'n/a'} chars`);
  console.log(`Description:        "${home.description ?? '(unavailable)'}"`);

  printSection('Current live /collections');
  console.log(`Title:              "${collections.title ?? '(unavailable)'}"`);
  console.log(`Description length: ${collections.description ? collections.description.length : 'n/a'} chars`);
  console.log(`Description:        "${collections.description ?? '(unavailable)'}"`);

  if (home.description && home.description === collections.description) {
    printSection('Confirmation');
    console.log('/collections serves the IDENTICAL description as the homepage —');
    console.log('both fall back to the same shop-level "Meta description" field.');
    console.log('Fixing the one Admin setting fixes both pages.');
  }

  printSection('Proposed replacements (required copy)');
  console.log(`New title:       "${TITLE}"`);
  console.log(`                  (${TITLE.length} chars)`);
  console.log(`New description: "${DESCRIPTION}"`);
  console.log(`                  (${DESCRIPTION.length} chars, under 160)`);

  printSection('Required manual action (Shopify Admin)');
  console.log('1. Go to Admin > Online Store > Preferences.');
  console.log('2. Set "Homepage title" to:');
  console.log(`     ${TITLE}`);
  console.log('3. Set "Homepage meta description" to:');
  console.log(`     ${DESCRIPTION}`);
  console.log('4. Save.');
  console.log('This also fixes /collections, since it falls back to the same field.');

  if (APPLY) {
    printSection('--apply');
    console.log('--apply was passed, but nothing was written. This codebase\'s Shopify');
    console.log('API surface (lib/shopify.js) has no writer for shop-level SEO fields —');
    console.log('`updateThemeAsset` only reaches theme files, and the shop does not own');
    console.log('this string in the theme. Apply the manual steps above in Admin; no');
    console.log('automated fallback exists.');
  } else {
    printSection('Dry run');
    console.log('No changes were made (this task has no automated write path — see above).');
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
