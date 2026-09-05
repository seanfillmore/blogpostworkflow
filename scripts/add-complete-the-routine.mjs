#!/usr/bin/env node
/**
 * Put the "Complete the routine" cross-sell on the PDPs that should have it.
 *
 *   node scripts/add-complete-the-routine.mjs            # DRY (default)
 *   node scripts/add-complete-the-routine.mjs --apply
 *   node scripts/add-complete-the-routine.mjs --remove --apply   # undo
 *
 * WHY
 * ───
 * `sections/complete-the-routine.liquid` has existed and worked for a while, and
 * renders on exactly ONE page: `/products/coconut-lotion`, pointing at the
 * Sensitive Skin Set. `docs/bundle-marketing-plan.md` §4 assigns the multipacks
 * to the "On-site cross-sell / cart" channel, and that channel had no
 * implementation at all — the bundles were reachable only from the Sets &
 * Bundles collection link added on 2026-08-29, which is a browse path, not an
 * at-the-buy-box one.
 *
 * This adds the SAME section, with the same shape as the one already live, to
 * the five PDPs whose category has a multipack behind it.
 *
 * THIS IS A THEME EDIT AND THE THEME IS NOT AUTO-DEPLOYED.
 * `git pull` on the server does nothing for `theme/`. This script talks to the
 * live theme through the Admin API, so an `--apply` here IS the deploy — there
 * is no second step, and equally no staging. Verify on the RENDERED page.
 *
 * LIP BALM IS DELIBERATELY ABSENT. There is no lip-balm multipack; the only
 * bundles containing one are Head-to-Toe ($87) and the Gift Box ($62), and
 * cross-selling an $87 bundle from the cheapest SKU in the catalogue is a guess,
 * not a plan. §4 does not assign lip balm to this channel either. Left out
 * rather than invented.
 */
import { getMainThemeId, getThemeAsset, updateThemeAsset, shopifyGraphQL } from '../lib/shopify.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apply = process.argv.includes('--apply');
const remove = process.argv.includes('--remove');
// `--only <pdp-handle>` — do one PDP. Development rule 4: prove a theme edit
// end-to-end on ONE page, on the rendered site, before touching the other four.
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1];

const SECTION_KEY = 'complete-the-routine';
const SECTION_TYPE = 'complete-the-routine';

/**
 * Frozen plan. `product` is a HANDLE — that is the shape the working live block
 * uses. Copy carries NO prices or savings: the section renders price,
 * compare-at and the saving from live Shopify data, so a number here could only
 * ever go stale and contradict the card it sits in.
 */
const PLAN = [
  {
    template: 'templates/product.landing-page-bar-soap.json',
    pdp: 'coconut-soap',
    product: 'coconut-bar-soap-4-pack',
    heading: 'Stock up and save',
    blurb: 'Four bars of the same soap, at a lower price per bar.',
    cta_label: 'View the 4-pack',
  },
  {
    template: 'templates/product.landing-page-liquid-soap.json',
    pdp: 'organic-foaming-hand-soap',
    product: 'coconut-hand-soap-4-pack',
    heading: 'Stock up and save',
    blurb: 'Four of the same foaming pump, at a lower price each.',
    cta_label: 'View the 4-pack',
  },
  {
    template: 'templates/product.landing-page-deodorant.json',
    pdp: 'coconut-oil-deodorant',
    product: 'coconut-deodorant-4-pack',
    heading: 'Stock up and save',
    blurb: 'Four of the same deodorant, at a lower price each.',
    cta_label: 'View the 4-pack',
  },
  {
    template: 'templates/product.landing-page-toothpaste.json',
    pdp: 'coconut-oil-toothpaste',
    product: 'coconut-toothpaste-3-pack',
    heading: 'Try all three flavours',
    blurb: 'One tube of each — Fresh Mint, All Natural and Cinnamon Spice.',
    cta_label: 'View the 3-pack',
  },
  {
    template: 'templates/product.landing-page-cream.json',
    pdp: 'coconut-moisturizer',
    product: 'sensitive-skin-starter-set',
    heading: 'Complete the routine',
    blurb: 'Pair the cream with the body lotion — the full sensitive-skin routine.',
    cta_label: 'View the set',
  },
];

const buildSection = (e) => ({
  type: SECTION_TYPE,
  settings: {
    product: e.product,
    heading: e.heading,
    blurb: e.blurb,
    cta_label: e.cta_label,
    accent_color: '#4a8b3c',
    background_color: '#faf8f4',
    padding_top: 16,
    padding_bottom: 16,
  },
});

async function main() {
  const themeId = await getMainThemeId();
  console.log(`Complete the routine — ${apply ? 'APPLY' : 'DRY RUN'}${remove ? ' (REMOVE)' : ''}`);
  console.log(`  live theme: ${themeId}\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join('data', 'reports', 'theme-backups', stamp);

  const planned = [];

  if (only && !PLAN.some((e) => e.pdp === only)) {
    throw new Error(`--only ${only} matches no plan entry. Known: ${PLAN.map((e) => e.pdp).join(', ')}`);
  }

  for (const e of PLAN) {
    if (only && e.pdp !== only) continue;
    // Never link to a product that is not actually buyable. A cross-sell card
    // pointing at a draft or deleted product is worse than no card.
    if (!remove) {
      const r = await shopifyGraphQL(
        'query($h:String!){ productByHandle(handle:$h){ id title status totalInventory } }',
        { h: e.product },
      );
      const p = r.productByHandle;
      if (!p) { console.log(`  ! ${e.product} not found — skipping ${e.pdp}`); continue; }
      if (p.status !== 'ACTIVE') { console.log(`  ! ${e.product} is ${p.status}, not ACTIVE — skipping ${e.pdp}`); continue; }
    }

    const raw = await getThemeAsset(themeId, e.template);
    if (!raw) { console.log(`  ! ${e.template} not found — skipping`); continue; }

    let json;
    try { json = JSON.parse(raw); } catch (err) {
      console.log(`  ! ${e.template} is not parseable JSON (${err.message}) — skipping`);
      continue;
    }

    const has = Object.entries(json.sections || {}).some(([, s]) => s.type === SECTION_TYPE);

    if (remove) {
      if (!has) { console.log(`  = ${e.pdp}: no ${SECTION_TYPE} section, nothing to remove`); continue; }
      const keys = Object.entries(json.sections).filter(([, s]) => s.type === SECTION_TYPE).map(([k]) => k);
      for (const k of keys) delete json.sections[k];
      json.order = (json.order || []).filter((k) => !keys.includes(k));
      planned.push({ e, raw, json, what: `${e.pdp}: REMOVE ${SECTION_TYPE}` });
      continue;
    }

    if (has) { console.log(`  = ${e.pdp}: already has a ${SECTION_TYPE} section`); continue; }

    json.sections = json.sections || {};
    json.sections[SECTION_KEY] = buildSection(e);

    // Directly after `main`, which is where the working one sits on the lotion
    // PDP — beside the buy box rather than below the reviews.
    const order = (json.order || []).filter((k) => k !== SECTION_KEY);
    const at = order.indexOf('main');
    json.order = at === -1
      ? [...order, SECTION_KEY]
      : [...order.slice(0, at + 1), SECTION_KEY, ...order.slice(at + 1)];

    planned.push({ e, raw, json, what: `${e.pdp}: add "${e.heading}" -> /products/${e.product}` });
  }

  if (!planned.length) { console.log('\nNothing to do.'); return; }

  console.log('\nPLANNED:');
  for (const p of planned) console.log(`  - ${p.what}`);

  if (!apply) {
    console.log('\nNothing was written. Re-run with --apply.');
    console.log('Note: --apply writes the LIVE theme directly. There is no staging step.');
    return;
  }

  mkdirSync(backupDir, { recursive: true });
  console.log(`\n  backups: ${backupDir}`);

  for (const p of planned) {
    writeFileSync(join(backupDir, p.e.template.replace(/\//g, '_')), p.raw);
    const serialized = JSON.stringify(p.json, null, 2);
    JSON.parse(serialized); // refuse to push anything that does not round-trip
    await updateThemeAsset(themeId, p.e.template, serialized);
    console.log(`  ✓ ${p.e.template}`);
  }

  console.log('\nDone. Verify on the RENDERED page — a theme write can succeed and still');
  console.log('render nothing if the section schema rejects a setting:');
  for (const p of planned) console.log(`  curl -s https://www.realskincare.com/products/${p.e.pdp} | grep -c ctr-card`);
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
