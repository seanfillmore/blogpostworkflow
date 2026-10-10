#!/usr/bin/env node
/**
 * Rewrite the title, bullets and description of the eight IN-STOCK Real Skin Care Amazon
 * listings (3 deodorant, 3 toothpaste, 2 lotion), and the backend search terms of the
 * three toothpastes.
 *
 * Dry by default — and the dry run is REAL: it sends the exact PATCH with
 * `mode=VALIDATION_PREVIEW`, so Amazon validates the payload without changing the listing.
 * `--apply` submits for real. Operator approved this set on 2026-10-10.
 *
 * WHY. Measured on the live listings 2026-10-10 (scripts/amazon/rsc-listing-copy-before.json):
 *   · Frankincense deodorant B4 carried a corrupted Arabic word ("مصنوعial fragrance-free")
 *     and "preventing irritation, bumps, and rashes" — a treatment claim, and the only live
 *     listing the commercial health gate refuses.
 *   · All three deodorant descriptions said the product keeps "sweat and odors at bay". A
 *     deodorant addresses odor; reducing sweat is what an antiperspirant (an OTC drug) does.
 *   · Fresh Mint's description claimed "antimicrobial properties" against bacteria behind
 *     "tooth decay", "anti-inflammatory" myrrh and a "teeth whitening formula" — the 2026-09-11
 *     bullet fix (remediate-toothpaste-bullets.mjs) never touched the description.
 *   · All Natural's description ended "Cinnamon Spice"; Natural/Cinnamon descriptions were a
 *     leftover title fragment.
 *   · Coconut Breeze lotion claimed "Reduce Fine Lines and Wrinkles", "tighten", "repair your
 *     skin" and "chemical-free", never named its scent, and carried the Unscented description
 *     ("six ingredients", "no artificial fragrance") although it has seven.
 *   · Unscented lotion named petroleum ingredients (negated), which the brand never does.
 *   · Toothpaste B4 "MADE FOR SENSITIVE TEETH" is the claim the OTC desensitizing-toothpaste
 *     category makes; operator chose "sensitive mouths" (2026-10-10).
 *   · Deodorant 3.2★: nothing on the listing told a buyer it will not stop sweat or how to
 *     use a baking-soda formula, the two usual causes of a bad natural-deodorant review.
 *
 * Every ingredient list is built from config/ingredients.json, and a test pins it.
 *
 * SAFETY. Per SKU, every field being written must equal its recorded BEFORE or its AFTER;
 * if any field matches neither, somebody edited the listing since this plan was written and
 * the whole SKU is SKIPPED, never overwritten. FBM twin SKUs are not touched — the detail
 * page takes its content from the main SKU (same rule as the 2026-09-11 script).
 *
 * Usage:
 *   node scripts/amazon/remediate-rsc-listing-copy.mjs            # Amazon validation preview
 *   node scripts/amazon/remediate-rsc-listing-copy.mjs --apply    # submit
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { submissionSucceeded, patchPath } from './remediate-toothpaste-bullets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'amazon-rsc-listing-copy');
export const BEFORE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'rsc-listing-copy-before.json'), 'utf8')).listings;
const INGREDIENTS = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

export const LIMITS = { item_name: 200, bullet: 500, product_description: 2000, generic_keyword_bytes: 249 };

const oilsOf = (product, variationName) => INGREDIENTS[product].variations
  .find((v) => v.name === variationName).essential_oils
  .map((o) => o.replace(/^organic essential oils? of /, '').replace(/\.$/, ''));
const listJoin = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const paras = (...ps) => ps.join('<br><br>');

// ── Deodorant ────────────────────────────────────────────────────────────────
const DEO_BASE = 'purified spring water, organic virgin coconut oil, organic jojoba, organic plant-based emulsifying wax, organic grapefruit seed extract, baking soda';
const DEO_NOTES = {
  'Calming Lavender': 'a soft herbal scent with a bright citrus edge',
  'Wildcrafted Frankincense': 'a warm, woody, resin scent',
  'Mountain Cedarwood': 'an earthy, woody scent',
};
function deodorant(scent) {
  const oils = listJoin(oilsOf('deodorant', scent));
  const note = DEO_NOTES[scent];
  return {
    item_name: `Real Skin Care Natural Deodorant Roll-On, ${scent}, Aluminum Free Organic Deodorant for Women & Men with Coconut Oil, Jojoba & Baking Soda, No Synthetic Fragrance, 2 fl oz, Made in USA`,
    bullet_point: [
      'ODOR CONTROL WITHOUT ALUMINUM: A roll-on deodorant made for one job, stopping underarm odor. It is a deodorant, not an antiperspirant, so there is no aluminum plugging your pores. You will still sweat normally while baking soda and coconut oil keep odor in check through the day.',
      `THE FULL INGREDIENT LIST, ON THE LISTING: ${DEO_BASE[0].toUpperCase()}${DEO_BASE.slice(1)}, and organic essential oils of ${oils}. That is all of it. No aluminum, parabens, propylene glycol, dyes or synthetic fragrance.`,
      `${scent.toUpperCase()} SCENT: ${note[0].toUpperCase()}${note.slice(1)}, from organic essential oils of ${oils}. Scented only with essential oils and light on the skin, so it works for women and men alike.`,
      'HONEST ABOUT BAKING SODA: Baking soda is what makes this work, and a small number of people find it too strong on freshly shaved skin. Apply to dry skin, wait a few minutes after shaving, and try a small area first. Switching from an antiperspirant? Give your body a couple of weeks to adjust.',
      'HANDMADE IN THE USA, SAFE FOR THE FAMILY: Made by hand in small batches in the USA. A 2 fl oz roll-on that fits a gym bag or carry-on, gentle enough for teens and kids, with no synthetic additives and nothing hidden behind the word "fragrance".',
    ],
    product_description: paras(
      'Real Skin Care Natural Deodorant is a handmade, aluminum free roll-on for women and men who want to read every ingredient on the label and understand it.',
      'It is a deodorant, not an antiperspirant. Antiperspirants use aluminum compounds to reduce sweat. This roll-on does not, so it targets odor instead: baking soda neutralizes it, and organic coconut oil and jojoba keep the formula smooth on the skin.',
      `Everything inside: ${DEO_BASE}, and organic essential oils of ${oils}. No aluminum, parabens, propylene glycol, dyes or synthetic fragrance.`,
      'How to use: roll two or three times onto clean, dry underarms. If you have just shaved, wait a few minutes first. If you are switching from an antiperspirant, expect a short adjustment period of a couple of weeks.',
      'Made by hand in small batches in the USA. 2 fl oz.',
    ),
  };
}

// ── Toothpaste ───────────────────────────────────────────────────────────────
// B4 is the only bullet that changes ("sensitive teeth" → "sensitive mouths"); B1-B3 and B5
// stay exactly as the 2026-09-11 remediation shipped them, so they are copied from BEFORE.
export const TOOTHPASTE_B4_BEFORE = 'MADE FOR SENSITIVE TEETH & TENDER GUMS: Formulated without SLS, fluoride, hydrated silica, glycerin or titanium dioxide, the ingredients most often behind irritation. Aluminum-free throughout. A gentle daily option if standard toothpaste leaves your mouth feeling raw.';
export const TOOTHPASTE_B4_AFTER = 'MADE FOR SENSITIVE MOUTHS & TENDER GUMS: Formulated without SLS, fluoride, hydrated silica, glycerin or titanium dioxide, the ingredients most often behind irritation. Aluminum-free throughout. A gentle daily option if standard toothpaste leaves your mouth feeling raw.';
const TP_KEYWORDS = {
  'Fresh Mint': 'peppermint spearmint mint',
  'All Natural': 'peppermint spearmint mint cinnamon clove herbal',
  'Cinnamon Spice': 'cinnamon clove spice herbal',
};
function toothpaste(flavor, sku) {
  const oils = listJoin(oilsOf('toothpaste', flavor));
  const taste = { 'Fresh Mint': 'mint', 'All Natural': 'mint and spice', 'Cinnamon Spice': 'cinnamon' }[flavor];
  const bullets = [...BEFORE[sku].bullet_point];
  bullets[3] = TOOTHPASTE_B4_AFTER;
  return {
    item_name: `Real Skin Care Coconut Oil Toothpaste, ${flavor}, Fluoride Free and SLS Free Natural Toothpaste with Baking Soda and Myrrh, No Glycerin, Organic Coconut Oil, Handmade in USA, for Adults and Kids`,
    bullet_point: bullets,
    product_description: paras(
      'Real Skin Care Coconut Oil Toothpaste is a fluoride free, SLS free toothpaste with a short ingredient list you can check line by line.',
      `Everything inside: purified spring water, organic virgin coconut oil, aluminum-free baking soda, xanthan gum, wildcrafted myrrh powder, stevia, and organic essential oils of ${oils}. No fluoride, SLS, glycerin, hydrated silica, titanium dioxide or synthetic flavor.`,
      `What to expect: there is no foaming detergent, so it will not lather like conventional toothpaste. The texture is smooth and gel-like, the baking soda polishes gently, and the ${taste} essential oils leave the mouth feeling fresh. Coconut oil can firm up below about 76°F; that is normal for an unrefined oil.`,
      'Handmade in small batches in the USA. Safe for kids and for incidental swallowing when used as directed.',
    ),
    generic_keyword: `natural organic fluoride free sls free glycerin free baking soda myrrh ${TP_KEYWORDS[flavor]} vegan non toxic kids adults gentle handmade gel no foam plant based coconut oil travel daily`,
  };
}

// ── Lotion ───────────────────────────────────────────────────────────────────
const LOTION_BASE = 'purified spring water, organic virgin coconut oil, organic jojoba, organic plant-based emulsifying wax, organic grapefruit seed extract, organic red palm oil';
function lotion(scent) {
  const extraOils = oilsOf('lotion', scent);
  const count = ['six', 'seven', 'eight'][extraOils.length] ?? String(6 + extraOils.length);
  const extra = extraOils.length ? `, and ${listJoin(extraOils)} for scent` : '';
  const scentLine = scent === 'Pure Unscented'
    ? 'NO ADDED FRAGRANCE: Pure Unscented has no essential oils and no fragrance of any kind, so there is nothing scented left on your skin.'
    : `${scent.toUpperCase()} SCENT: A light, natural coconut scent from ${listJoin(extraOils)}. No synthetic fragrance.`;
  return {
    item_name: scent === 'Pure Unscented'
      ? 'Real Skin Care Unscented Body Lotion, Fragrance Free Organic Moisturizer with Coconut Oil and Jojoba for Dry and Sensitive Skin, Non-Greasy, Six Ingredients, Paraben Free, 8 oz, Made in USA'
      : `Real Skin Care Coconut Body Lotion, ${scent}, Organic Moisturizer with Coconut Oil and Jojoba for Dry Skin, Lightweight and Non-Greasy, No Synthetic Fragrance, Paraben Free, 8 oz, Made in USA`,
    bullet_point: [
      `${count.toUpperCase()} INGREDIENTS, ALL LISTED: ${LOTION_BASE[0].toUpperCase()}${LOTION_BASE.slice(1)}${extra}. Nothing else. No parabens, dimethicone, alcohol or synthetic fragrance.`,
      'SOAKS IN, NOT GREASY: Absorbs into the skin instead of sitting on top, so dry skin feels soft and smooth without a sticky or oily layer. Comfortable for daily use on hands, arms, legs and face.',
      'COLD-PRESSED COCONUT OIL AND JOJOBA: Organic virgin coconut oil moisturizes, jojoba is close in makeup to the oil your skin produces, and unrefined red palm oil brings natural vitamin E and beta-carotene.',
      `${scentLine} Gentle enough for sensitive skin and for the whole family, kids included.`,
      'HANDMADE IN THE USA: Made by hand in small batches. Because the oils are minimally processed, the lotion can thicken in cool weather. That is normal; warm a little between your palms and it spreads smoothly.',
    ],
    product_description: paras(
      `Real Skin Care ${scent} Body Lotion is a handmade organic moisturizer built on ${count} ingredients, every one of them listed on the bottle and on this page.`,
      `Everything inside: ${LOTION_BASE}${extra}. No parabens, dimethicone, alcohol or synthetic fragrance.`,
      'It absorbs instead of sitting on the skin, so dry skin feels soft without a greasy film. Use it on hands, body and face, every day, for every member of the family.',
      'The oils are minimally processed, so the texture can firm up in cool weather. Warm a small amount between your hands before applying. Handmade in small batches in the USA. 8 oz.',
    ),
  };
}

export const PLAN = [
  { sku: 'RSC-DE-CL-02', product: 'deodorant', variant: 'Calming Lavender', after: deodorant('Calming Lavender') },
  { sku: 'RSC-DE-WF-02', product: 'deodorant', variant: 'Wildcrafted Frankincense', after: deodorant('Wildcrafted Frankincense') },
  { sku: 'RSC-DE-MC-02', product: 'deodorant', variant: 'Mountain Cedarwood', after: deodorant('Mountain Cedarwood') },
  { sku: 'RSC-TP-MI-08', product: 'toothpaste', variant: 'Fresh Mint', after: toothpaste('Fresh Mint', 'RSC-TP-MI-08') },
  { sku: 'RSC-TP-NA-08', product: 'toothpaste', variant: 'All Natural', after: toothpaste('All Natural', 'RSC-TP-NA-08') },
  { sku: 'RSC-TP-CI-08', product: 'toothpaste', variant: 'Cinnamon Spice', after: toothpaste('Cinnamon Spice', 'RSC-TP-CI-08') },
  { sku: 'RSC-LO-PU-08-stickerless', product: 'lotion', variant: 'Pure Unscented', after: lotion('Pure Unscented') },
  { sku: 'RSC-LO-CB-08-FBA-stickerless', product: 'lotion', variant: 'Coconut Breeze', after: lotion('Coconut Breeze') },
].map((e) => ({ ...e, asin: BEFORE[e.sku].asin, before: BEFORE[e.sku] }));

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Live en_US values for the attributes this plan writes. Bullets as an array, the rest as a string. */
export function liveValues(attributes, marketplaceId, fields) {
  const out = {};
  for (const f of fields) {
    const vals = (attributes?.[f] ?? [])
      .filter((v) => (v.marketplace_id ?? marketplaceId) === marketplaceId && (v.language_tag ?? 'en_US') === 'en_US')
      .map((v) => v.value);
    out[f] = f === 'bullet_point' ? vals : (vals[0] ?? null);
  }
  return out;
}

/** apply | already-applied | skip, field by field against BEFORE and AFTER. */
export function decideListing(entry, live) {
  const fields = Object.keys(entry.after);
  const pending = [];
  for (const f of fields) {
    if (eq(live[f], entry.after[f])) continue;
    if (eq(live[f], entry.before[f])) { pending.push(f); continue; }
    return { action: 'skip', fields: [], why: `${f} matches neither BEFORE nor AFTER — edited since this plan was written` };
  }
  if (!pending.length) return { action: 'already-applied', fields: [], why: 'every field already carries the AFTER value' };
  return { action: 'apply', fields: pending, why: `live matches BEFORE on ${pending.join(', ')}` };
}

export function buildPatch(entry, fields, { productType, marketplaceId }) {
  const v = (value) => ({ value, language_tag: 'en_US', marketplace_id: marketplaceId });
  return {
    productType,
    patches: fields.map((f) => ({
      op: 'replace',
      path: `/attributes/${f}`,
      value: f === 'bullet_point' ? entry.after[f].map(v) : [v(entry.after[f])],
    })),
  };
}

function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

/** `outDir` is injectable so tests never write run records into the real report directory. */
export async function main({ spapi, argv = process.argv, sellerId, outDir = OUT_DIR } = {}) {
  const apply = argv.includes('--apply');
  const sp = spapi ?? await import('../../lib/amazon/sp-api-client.js');
  const client = await sp.getClient();
  const marketplaceId = sp.getMarketplaceId();
  const seller = sellerId ?? envValue('AMAZON_SPAPI_SELLER_ID');
  if (!seller) throw new Error('AMAZON_SPAPI_SELLER_ID not set');

  const results = [];
  let failed = 0;
  for (const entry of PLAN) {
    const item = await sp.request(client, 'GET',
      `/listings/2021-08-01/items/${encodeURIComponent(seller)}/${encodeURIComponent(entry.sku)}`,
      { marketplaceIds: marketplaceId, includedData: 'summaries,attributes' });
    const productType = item?.summaries?.[0]?.productType;
    const live = liveValues(item?.attributes, marketplaceId, Object.keys(entry.after));
    const decision = decideListing(entry, live);
    const row = { sku: entry.sku, asin: entry.asin, variant: entry.variant, productType, ...decision, before_live: live };
    results.push(row);
    console.log(`\n${entry.variant} ${entry.sku} (${entry.asin}) — ${decision.action.toUpperCase()}: ${decision.why}`);
    if (decision.action !== 'apply') continue;
    if (!productType) throw new Error(`${entry.sku}: no productType on the live listing`);

    const res = await sp.request(client, 'PATCH',
      patchPath({ sellerId: seller, sku: entry.sku, marketplaceId, apply }),
      buildPatch(entry, decision.fields, { productType, marketplaceId }));
    const errors = (res?.issues ?? []).filter((i) => i.severity === 'ERROR');
    row.submission = { mode: apply ? 'LIVE' : 'VALIDATION_PREVIEW', status: res?.status, submissionId: res?.submissionId, issues: res?.issues ?? [] };
    if (!submissionSucceeded(res, { apply }) || errors.length) failed += 1;
    console.log(`  ${apply ? 'SUBMITTED' : 'VALIDATION PREVIEW'} → status ${res?.status}, ${(res?.issues ?? []).length} issue(s)`);
    for (const i of res?.issues ?? []) console.log(`    [${i.severity}] ${i.code}: ${i.message}`);
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = { generated_at: new Date().toISOString(), applied: apply, results };
  writeFileSync(join(outDir, `run-${stamp}.json`), JSON.stringify(record, null, 2));
  console.log(`\nRun record: ${join(outDir, `run-${stamp}.json`)}`);
  return { ...record, failed };
}

if (isDirectRun(import.meta.url)) {
  main()
    .then((r) => process.exit(r.failed ? 2 : 0))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
