#!/usr/bin/env node
/**
 * Replace the five Amazon bullets on the three Real Skin Care toothpaste SKUs.
 *
 * Dry by default — and the dry run is REAL: it sends the exact PATCH with
 * `mode=VALIDATION_PREVIEW`, so Amazon validates the payload (length, attribute schema,
 * policy issues) without changing the listing. `--apply` submits for real.
 *
 * WHY. Measured on the live listings 2026-09-11:
 *   · All Natural (B0B6DHNCW3) and Cinnamon Spice (B0B6DQTL11) carry identical bullets
 *     naming "organic essential oils of peppermint and spearmint". Cinnamon Spice contains
 *     NEITHER, and All Natural contains four oils, not two.
 *   · Fresh Mint (B0B6DYZF5H) names "antimicrobial action", "anti-inflammatory properties"
 *     and "inflamed gums" — intended-use language on a cosmetic.
 *   · None of the three prints a labelled ingredient list, the tactic adopted from video
 *     twDUexmWaws ("publish the full ingredient list on-listing").
 * Operator approved this replacement set on 2026-09-11 ("Ship them").
 *
 * FLAVOR OILS come from config/ingredients.json (in the repo since the first commit) and
 * were checked against the live front-label photos: Fresh Mint shows mint; All Natural
 * shows mint, cloves and cinnamon; Cinnamon Spice shows cinnamon sticks only — so clove on
 * Cinnamon Spice rests on the config alone, and the operator was told so before approving.
 * A test pins every B1 against the config, so a formula change fails the build rather than
 * silently shipping a wrong ingredient list.
 *
 * SAFETY. Each SKU's live bullets must equal the recorded BEFORE exactly, or equal the
 * AFTER (already applied); anything else is somebody's newer edit and is SKIPPED, never
 * overwritten. The FBM twins (RSC-TP-*-08-FBM) carry no bullet attribute and are not
 * touched — the detail page takes its bullets from the main SKU.
 *
 * Usage:
 *   node scripts/amazon/remediate-toothpaste-bullets.mjs            # Amazon validation preview
 *   node scripts/amazon/remediate-toothpaste-bullets.mjs --apply    # submit
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'amazon-toothpaste-bullets');
export const MAX_BULLET_CHARS = 500;

const b1 = (oils) => 'NATURAL TOOTHPASTE MADE IN THE USA: A fluoride free toothpaste you can actually check. '
  + 'Ingredients: purified spring water, organic virgin coconut oil, aluminum-free baking soda, xanthan gum, '
  + `wildcrafted myrrh powder, stevia, ${oils}. `
  + 'No fluoride, no SLS, no glycerin, no titanium dioxide and no synthetic additives.';

export const SHARED_BULLETS = [
  'NO HARSH FOAMING AGENTS: Conventional toothpaste depends on synthetic foaming detergents. This one does not, '
    + 'so it will not foam the way you are used to and has a smooth, gel-like texture. Coconut oil and '
    + 'aluminum-free baking soda help neutralize acids and leave the mouth feeling clean, without the harsh '
    + 'detergents or the excessive foam.',
  'COLD-PRESSED COCONUT OIL, BAKING SODA & MYRRH: The coconut oil is cold-pressed and unrefined, so it keeps what '
    + 'a refining process would strip out. Aluminum-free baking soda gently polishes and lifts surface stains '
    + 'instead of the cheap grit that is harder than your enamel. Wildcrafted myrrh has been used in oral care '
    + 'for centuries and is included here for gum comfort.',
  'MADE FOR SENSITIVE TEETH & TENDER GUMS: Formulated without SLS, fluoride, hydrated silica, glycerin or '
    + 'titanium dioxide, the ingredients most often behind irritation. Aluminum-free throughout. A gentle daily '
    + 'option if standard toothpaste leaves your mouth feeling raw.',
  'CLEAN ORAL CARE, FULLY DISCLOSED: Every ingredient is listed above and every one has a clear purpose. '
    + 'Handmade in the United States in small batches from food-derived ingredients, with no hidden fillers, '
    + 'harsh detergents or artificial flavor systems. Safe for incidental swallowing when used as directed, '
    + 'which matters if your kids brush with it too.',
];

const OLD_NA_CI = [
  '【ORGANIC DENTAL CARE, HANDMADE IN THE USA】At Real Skin Care, we proudly source our ingredients from small family farms and batch distilleries from around the world to promote values of fair trade and sustainability. Additionally, all of our products are handmade with love and care right here in the United States.',
  '【FLUORIDE FREE TOOTHPASTE】Experience the benefits of our organic toothpaste, crafted from pure ingredients like purified spring water, organic virgin coconut oil, baking soda, xanthan gum, wildcrafted myrrh powder, stevia, and organic essential oils of peppermint and spearmint.',
  '【GO GREEN, SMILE CLEAN】Revitalize your oral care routine with our exceptional organic toothpaste. Our deep cleansing toothpaste combines organic virgin coconut oil and baking soda for a sparkling, white smile. With a special blend of organic peppermint and spearmint essential oils, enjoy a refreshing burst of fresh breath.',
  "【GENTLE & NON-TOXIC】Our non-toxic toothpaste is expertly crafted for sensitive gums. This healthy toothpaste offers a gentle yet robust defense against oral issues, plus it's free from chemicals and artificial foaming agents",
  '【FRESH BREATH EVERYWHERE YOU GO】Embark on a refreshing oral care journey with our flavored coconut oil toothpaste, perfectly combining convenience and taste. Crafted with care, this travel sized toothpaste provides a revitalizing and refreshing brushing experience wherever you go.',
];

const OLD_FRESH_MINT = [
  'NATURAL TOOTHPASTE MADE IN USA: This fluoride free toothpaste is made with carefully selected, recognizable ingredients for clean oral care. Formulated with spring water, cold-pressed virgin coconut oil, aluminum-free baking soda, xanthan gum, wildcrafted myrrh, and organic stevia. No fluoride, no SLS, no glycerin, no titanium dioxide, or synthetic additives.',
  'SUPPORT ORAL HEALTH WITHOUT HARSH FOAMING AGENTS: Unlike conventional toothpaste that depends on synthetic foaming detergents, this natural toothpaste helps support a balanced oral environment. Lauric acid from coconut oil and aluminum-free baking soda help reduce odor-causing bacteria while gently neutralizing acids, allowing a cleaner mouth feel without harsh chemical irritation or excessive foam.',
  'POWERED BY COLD-PRESSED COCONUT OIL, BAKING SODA & MYRRH: Cold-pressed virgin coconut oil retains lauric acid, known for antimicrobial action against harmful oral bacteria. Aluminum-free baking soda gently neutralizes acidity and lifts surface stains without enamel damage. Wildcrafted myrrh supports gum comfort with traditional anti-inflammatory properties used in oral care for centuries.',
  'DESIGNED FOR SENSITIVE TEETH & GUMS: This fluoride free toothpaste sensitive teeth is formulated without SLS, fluoride, hydrated silica, glycerin, or titanium dioxide to minimize irritation and enamel stress. It does not foam like standard toothpaste and has a smooth gel-like texture, making it suitable for sensitive teeth, inflamed gums, and daily gentle oral hygiene use.',
  'BUILT AROUND CLEAN ORAL CARE & TRANSPARENT INGREDIENTS: Created for people seeking simple, honest oral care, this natural toothpaste uses food-derived ingredients with clear purpose. Every component supports gum comfort, bacterial balance, and enamel-safe cleaning. Safe for incidental swallowing when used as directed, with no hidden fillers, harsh detergents, or artificial flavor systems.',
];

export const PLAN = [
  {
    variant: 'fresh-mint', sku: 'RSC-TP-MI-08', asin: 'B0B6DYZF5H',
    oils: 'organic peppermint and spearmint essential oils',
    before: OLD_FRESH_MINT,
    after: [b1('organic peppermint and spearmint essential oils'), ...SHARED_BULLETS],
  },
  {
    variant: 'all-natural', sku: 'RSC-TP-NA-08', asin: 'B0B6DHNCW3',
    oils: 'organic peppermint, spearmint, cinnamon and clove essential oils',
    before: OLD_NA_CI,
    after: [b1('organic peppermint, spearmint, cinnamon and clove essential oils'), ...SHARED_BULLETS],
  },
  {
    variant: 'cinnamon-spice', sku: 'RSC-TP-CI-08', asin: 'B0B6DQTL11',
    oils: 'organic cinnamon and clove essential oils',
    before: OLD_NA_CI,
    after: [b1('organic cinnamon and clove essential oils'), ...SHARED_BULLETS],
  },
];

const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/** apply | already-applied | skip, against the live en_US bullet values. */
export function decideListing(entry, liveBullets) {
  if (!Array.isArray(liveBullets)) return { action: 'skip', why: 'no bullet_point attribute on the live listing' };
  if (same(liveBullets, entry.after)) return { action: 'already-applied', why: 'live already carries the AFTER bullets' };
  if (same(liveBullets, entry.before)) return { action: 'apply', why: 'live matches the recorded BEFORE exactly' };
  return { action: 'skip', why: 'live matches neither BEFORE nor AFTER — the listing has been edited since this plan was written' };
}

export function buildPatch(entry, { productType, marketplaceId }) {
  return {
    productType,
    patches: [{
      op: 'replace',
      path: '/attributes/bullet_point',
      value: entry.after.map((value) => ({ value, language_tag: 'en_US', marketplace_id: marketplaceId })),
    }],
  };
}

/**
 * The two modes report success with DIFFERENT statuses: a validation preview answers
 * `VALID`, a real submission `ACCEPTED`. Checking for `ACCEPTED` alone would call every
 * clean preview a failure — which the first live dry run did.
 */
export function submissionSucceeded(res, { apply }) {
  return res?.status === (apply ? 'ACCEPTED' : 'VALID');
}

export function patchPath({ sellerId, sku, marketplaceId, apply }) {
  const qs = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: 'en_US' });
  if (!apply) qs.set('mode', 'VALIDATION_PREVIEW');
  return `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${qs}`;
}

function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

export async function main({ spapi, argv = process.argv, sellerId } = {}) {
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
    const live = (item?.attributes?.bullet_point ?? [])
      .filter((b) => b.marketplace_id === marketplaceId && (b.language_tag ?? 'en_US') === 'en_US')
      .map((b) => b.value);
    const decision = decideListing(entry, live.length ? live : null);
    const row = { variant: entry.variant, sku: entry.sku, asin: entry.asin, productType, ...decision, before_live: live };
    results.push(row);
    console.log(`\n${entry.variant} ${entry.sku} (${entry.asin}) — ${decision.action.toUpperCase()}: ${decision.why}`);
    if (decision.action !== 'apply') continue;
    if (!productType) throw new Error(`${entry.sku}: no productType on the live listing`);

    const res = await sp.request(client, 'PATCH',
      patchPath({ sellerId: seller, sku: entry.sku, marketplaceId, apply }),
      buildPatch(entry, { productType, marketplaceId }));
    const errors = (res?.issues ?? []).filter((i) => i.severity === 'ERROR');
    row.submission = { mode: apply ? 'LIVE' : 'VALIDATION_PREVIEW', status: res?.status, submissionId: res?.submissionId, issues: res?.issues ?? [] };
    if (!submissionSucceeded(res, { apply }) || errors.length) failed += 1;
    console.log(`  ${apply ? 'SUBMITTED' : 'VALIDATION PREVIEW'} → status ${res?.status}, ${(res?.issues ?? []).length} issue(s)`);
    for (const i of res?.issues ?? []) console.log(`    [${i.severity}] ${i.code}: ${i.message}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = { generated_at: new Date().toISOString(), applied: apply, results };
  writeFileSync(join(OUT_DIR, `run-${stamp}.json`), JSON.stringify(record, null, 2));
  console.log(`\nRun record: ${join(OUT_DIR, `run-${stamp}.json`)}`);
  return { ...record, failed };
}

if (isDirectRun(import.meta.url)) {
  main()
    .then((r) => process.exit(r.failed ? 2 : 0))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
