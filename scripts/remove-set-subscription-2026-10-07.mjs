#!/usr/bin/env node
/**
 * Take the subscription offer off the Sensitive Skin Set (Sean, 2026-10-07:
 * "Yes" to removing the plan and the subscription-gift image; multi-unit over
 * subscriptions).
 *
 *   node scripts/remove-set-subscription-2026-10-07.mjs            # dry run
 *   node scripts/remove-set-subscription-2026-10-07.mjs --apply
 *
 * 1. Template (product.landing-page-sensitive-skin-set-lander.json): the four
 *    places that sell a subscription. Hero badge "Free shipping on subscription"
 *    -> "Free shipping" (true without one: the set's price clears the $45
 *    free-shipping bar, checked live before writing); the details tab's
 *    "First-subscription bonus" paragraph removed; the "First subscription order
 *    includes" banner removed from the page; the final strip's subscription line
 *    replaced. Every new line is gated.
 * 2. Gallery: frame-06-subscription-gift.jpg archived, then DETACHED from the
 *    product (fileUpdate referencesToRemove), never deleted.
 * 3. Recurpay plan 11150632, attached to this product only, deleted. Refuses if
 *    the plan covers any other product or if any subscription on the set is not
 *    cancelled: deleting a plan under a live contract is not this script's call.
 *
 * Order: page copy and image first, plan last, so the page never promises a
 * subscription the store can no longer sell.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { serialize } from './build-product-templates.mjs';
import { bulletProblems } from './apply-pdp-outcome-bullets.mjs';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'templates/product.landing-page-sensitive-skin-set-lander.json';
const SET_HANDLE = 'sensitive-skin-starter-set';
const SET_PRODUCT_ID = 8390839468202;
const PLAN_ID = 11150632;
const GIFT_IMAGE = 'frame-06-subscription-gift.jpg';
const FREE_SHIPPING_MIN = 45;

export const NEW_COPY = {
  heroBadge: 'Free shipping',
  finalStrip: '<p>Lotion for the day, cream for the night. Both Pure Unscented, with a 30-day money-back guarantee.</p>',
};

/** Pure: apply the four copy changes. Returns notes; throws if an anchor moved. */
export function stripSubscriptionCopy(parsed) {
  const notes = [];
  const g = parsed.sections?.hero?.blocks?.['guarantee-1'];
  if (!g) throw new Error('hero/guarantee-1 not found');
  if (/subscri/i.test(g.settings.text)) { g.settings.text = NEW_COPY.heroBadge; notes.push('hero badge -> "Free shipping"'); }

  const tab = parsed.sections?.main?.blocks?.['tab-details'];
  if (!tab) throw new Error('main/tab-details not found');
  for (const k of ['content', 'custom_liquid']) {
    const v = tab.settings[k];
    if (typeof v === 'string' && /First-subscription bonus/.test(v)) {
      tab.settings[k] = v.replace(/<p><strong>First-subscription bonus\.<\/strong>[\s\S]*?<\/p>/, '');
      notes.push('details tab: bonus paragraph removed');
    }
  }

  const main = parsed.sections.main;
  if (main.block_order.includes('bonus-banner')) {
    main.block_order = main.block_order.filter((b) => b !== 'bonus-banner');
    delete main.blocks['bonus-banner'];
    notes.push('bonus-banner removed');
  }

  const fc = parsed.sections?.['final-cta-strip']?.blocks?.['fc-text'];
  if (!fc) throw new Error('final-cta-strip/fc-text not found');
  if (/subscri/i.test(fc.settings.text)) { fc.settings.text = NEW_COPY.finalStrip; notes.push('final strip line replaced'); }

  const left = JSON.stringify(parsed).replace(/no-subscription[\s\S]*?endcomment/g, '');
  const stillSells = /First[- ]subscription|subscription order|Subscribe and/i.test(left);
  if (stillSells) throw new Error('subscription copy still present after the edit');
  return notes;
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  for (const line of [NEW_COPY.heroBadge, NEW_COPY.finalStrip.replace(/<[^>]+>/g, '')]) {
    const p = bulletProblems(line);
    if (p.length) throw new Error(`"${line}" fails: ${p.join(', ')}`);
  }
  const { shopifyGraphQL } = await import('../lib/shopify.js');
  const { getPlanProducts, listSubscriptions, deletePlan } = await import('../lib/recurpay.js');

  // Preconditions for the plan delete, checked BEFORE anything is written.
  const prods = await getPlanProducts(PLAN_ID);
  const ids = (prods.data ?? prods).map((x) => Number(x.id));
  if (ids.some((id) => id !== SET_PRODUCT_ID)) throw new Error(`plan ${PLAN_ID} covers other products: ${ids}`);
  const subs = await listSubscriptions();
  const onSet = (subs.data ?? subs.subscriptions ?? subs).filter((s) => JSON.stringify(s.line_items ?? s.items ?? '').includes(String(SET_PRODUCT_ID)));
  const live = onSet.filter((s) => s.status !== 'cancelled');
  if (live.length) throw new Error(`refusing: live subscriptions on the set: ${live.map((s) => `${s.id}:${s.status}`)}`);
  const priceRes = await shopifyGraphQL(`{ productByIdentifier(identifier:{handle:"${SET_HANDLE}"}) { id priceRangeV2 { minVariantPrice { amount } }
    media(first: 20) { nodes { id ... on MediaImage { image { url } } } } } }`);
  const prod = priceRes.productByIdentifier;
  if (Number(prod.priceRangeV2.minVariantPrice.amount) < FREE_SHIPPING_MIN) throw new Error('set no longer clears the free-shipping bar; "Free shipping" would be false');
  console.log(`plan ${PLAN_ID}: covers only the set; subscriptions on the set: ${onSet.map((s) => s.status).join(', ') || 'none'}`);

  // 1. Template
  const work = join(ROOT, 'data', 'set-nosub'); mkdirSync(work, { recursive: true });
  execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'get', KEY, join(work, 'live.json')], { stdio: 'ignore' });
  const liveRaw = readFileSync(join(work, 'live.json'), 'utf8');
  if (serialize(JSON.parse(liveRaw)) !== liveRaw) throw new Error('round-trip mismatch — refusing');
  const parsed = JSON.parse(liveRaw);
  const notes = stripSubscriptionCopy(parsed);
  console.log(`template:\n  ${notes.join('\n  ') || 'already clean'}`);
  const next = serialize(parsed);

  // 2. Gift image
  const gift = prod.media.nodes.find((n) => n.image?.url && n.image.url.split('/').pop().split('?')[0] === GIFT_IMAGE);
  console.log(`gallery: ${gift ? `${GIFT_IMAGE} attached (${gift.id})` : `${GIFT_IMAGE} not attached`}`);

  if (!APPLY) { console.log('\nDry run. --apply to write.'); return; }

  if (next !== liveRaw) {
    writeFileSync(join(work, 'next.json'), next);
    execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'put', KEY, join(work, 'next.json'), '--apply'], { stdio: 'inherit' });
    writeFileSync(join(ROOT, 'theme', KEY), next);
  }
  if (gift) {
    const archive = join(ROOT, 'data', 'archive', 'set-subscription-gift-2026-10-07');
    mkdirSync(archive, { recursive: true });
    const dest = join(archive, GIFT_IMAGE);
    if (!existsSync(dest)) {
      const r = await fetch(gift.image.url.split('?')[0]);
      if (!r.ok) throw new Error(`could not archive ${GIFT_IMAGE} (${r.status}) — refusing to detach`);
      writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    }
    const d = await shopifyGraphQL(`mutation Detach($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { field message } } }`,
      { files: [{ id: gift.id, referencesToRemove: [prod.id] }] });
    if (d.fileUpdate.userErrors.length) throw new Error(JSON.stringify(d.fileUpdate.userErrors));
    console.log(`  detached ${GIFT_IMAGE} (archived to ${dest.replace(ROOT + '/', '')})`);
  }
  await deletePlan(PLAN_ID);
  console.log(`  deleted Recurpay plan ${PLAN_ID}`);
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
