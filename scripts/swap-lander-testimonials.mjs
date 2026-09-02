#!/usr/bin/env node
/**
 * Swap the two claim-carrying UGC testimonials on the Sensitive Skin Set lander.
 *
 *   node scripts/swap-lander-testimonials.mjs --in <live template.json> [--out <file>]
 *
 * WHY THIS TEMPLATE. A sweep of all 61 theme JSON templates and section groups
 * on 2026-09-02 (6,851 strings) found 26 blocking-tier hits across 7 templates.
 * `product.landing-page-sensitive-skin-set-lander.json` is the worst live one:
 * it is the template for `sensitive-skin-starter-set`, the store's hero bundle,
 * and its `ugc-photos` section carried the SAME quote PR #758 just removed from
 * the homepage — verified rendering live before this was written.
 *
 *   ugc-1  eczema + prescription + steroids   ← the 2026-08-16 incident quote
 *   ugc-3  "chronic dry skin and eczema"      ← same class, milder
 *
 * Both are advertiser-SELECTED endorsements, which is what makes them the
 * store's speech: the FTC holds an advertiser responsible for what an
 * endorsement conveys, and the FDA reads testimonials as evidence of intended
 * use. Note the contrast with the Judge.me widget lower down the same page,
 * which renders 65 customer mentions of the same word — an unfiltered review
 * feed is not a selected claim, and nothing here touches it.
 *
 * SWAPPED, NOT EDITED, and the replacements are VERBATIM — an advertiser may
 * not put words in an endorser's mouth. Chosen from the same 179 gate-clean
 * 5-star candidates PR #758 used, filtered further to names already unused on
 * this page and screened past the gate for `diabetic`, which the vocabulary
 * does not carry and which turned up in a candidate (see NOTE below).
 *
 * The photos are scene shots (a bathroom counter, a nightstand tray), not
 * portraits, so the image blocks are left untouched and only the name and quote
 * move. NOTE Ella M.'s Judge.me `verified` value is "buyer" rather than
 * "verified-purchase"; the section labels blocks with a name only and makes no
 * "verified customer" claim, so nothing on the page overstates it.
 *
 * Upload with update-theme-asset.mjs, which backs up and diffs first. This
 * script writes no Shopify state. IDEMPOTENT; SKIPS rather than overwrites when
 * a live value matches neither BEFORE nor AFTER.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../agents/ad-studio/health-claims.js';
import { serializeTemplate } from './merge-homepage-soap-cards.mjs';

export const TEMPLATE_KEY = 'templates/product.landing-page-sensitive-skin-set-lander.json';
export const SECTION = 'ugc-photos';

export const PLAN = [
  {
    block: 'ugc-1',
    oldName: 'Jessica V.',
    oldText: '<p>"I have horrible eczema and cracked feet. I\'ve tried prescription lotions, steroids, everything over the counter. Nothing worked — until Real Skin Care. Apply morning and night and my skin stays hydrated all day."</p>',
    name: 'Ella M.',
    body: 'Incredibly soft. Doesn’t make you feel greasy or sticky after use. It makes you feel incredibly moisturized.',
    source: { reviewId: 514327202, product: 'Coconut Moisturizer | 4oz', createdAt: '2023-12-31', rating: 5, verified: 'buyer' },
  },
  {
    block: 'ugc-3',
    oldName: 'Heather D.',
    oldText: '<p>"The cleanest lotion and cream we\'ve found. Not greasy, really works — especially for chronic dry skin and eczema. So hard to find brands without a ton of chemicals."</p>',
    name: 'Michaela',
    body: 'I love this lotion. It feels great on my skin and isn’t irritating. I love that you can read the ingredients and it’s all things I know. Great value and great for your skin!',
    source: { reviewId: 378035520, product: 'Organic Body Lotion', createdAt: '2023-01-26', rating: 5, verified: 'verified-purchase' },
  },
];

/** The page wraps each quote in a <p> with straight double quotes. */
export const renderQuote = (body) => `<p>"${body}"</p>`;

export function swapTestimonials(template, plan = PLAN) {
  const next = JSON.parse(JSON.stringify(template));
  const section = next.sections?.[SECTION];
  const applied = [];
  const skipped = [];
  if (!section) return { template: next, applied, skipped: plan.map((e) => ({ ...e, why: 'section not found' })) };

  for (const e of plan) {
    const block = section.blocks?.[e.block];
    if (!block) { skipped.push({ ...e, why: 'block not found' }); continue; }
    const after = renderQuote(e.body);
    if (block.settings.text === after && block.settings.title === e.name) {
      skipped.push({ ...e, why: 'already applied' }); continue;
    }
    if (block.settings.text !== e.oldText || block.settings.title !== e.oldName) {
      skipped.push({ ...e, why: 'live value matches neither BEFORE nor AFTER' }); continue;
    }
    block.settings.text = after;
    block.settings.title = e.name;
    applied.push(e);
  }
  return { template: next, applied, skipped };
}

async function main() {
  const arg = (f) => { const i = process.argv.indexOf(f); return i === -1 ? null : process.argv[i + 1]; };
  const input = arg('--in');
  const out = arg('--out');
  if (!input) { console.error(`usage: swap-lander-testimonials.mjs --in <${TEMPLATE_KEY}> [--out <file>]`); process.exit(2); }

  for (const e of PLAN) {
    const g = checkSeoCopyFields({ testimonial: e.body });
    if (!g.ok) throw new Error(`${e.block}: replacement trips the SEO gate — ${g.blocking.map((v) => `${v.category}:"${v.match}"`).join(', ')}`);
    if (hasHealthClaim(e.body)) throw new Error(`${e.block}: replacement trips the ad-studio health gate`);
  }
  console.log(`  ✓ all ${PLAN.length} replacements pass both health gates\n`);

  const template = JSON.parse(readFileSync(input, 'utf8'));
  const { template: next, applied, skipped } = swapTestimonials(template);

  for (const e of applied) {
    console.log(`  ${SECTION}/${e.block}`);
    console.log(`    - ${e.oldName}: ${e.oldText.replace(/<[^>]+>/g, '')}`);
    console.log(`    + ${e.name}: ${renderQuote(e.body).replace(/<[^>]+>/g, '')}`);
    console.log(`      source: Judge.me ${e.source.reviewId} · ${e.source.rating}★ · ${e.source.verified} · ${e.source.product} · ${e.source.createdAt}\n`);
  }
  for (const e of skipped) console.log(`  = ${e.block}: ${e.why}`);

  if (!applied.length) { console.log('\nNothing to do.'); return; }
  if (!out) { console.log('\nNothing written. Re-run with --out <file>.'); return; }
  writeFileSync(out, serializeTemplate(next));
  console.log(`\n  wrote ${out}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
}
