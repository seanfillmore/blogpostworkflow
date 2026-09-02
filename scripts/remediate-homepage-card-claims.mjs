#!/usr/bin/env node
/**
 * Remove a blocking health claim from the homepage product cards.
 *
 *   node scripts/remediate-homepage-card-claims.mjs --in <live index.json>
 *   node scripts/remediate-homepage-card-claims.mjs --in <live> --out <file>
 *
 * SCOPE IS ONE CARD, AND THAT IS A DECISION. Gating all 126 strings in
 * `templates/index.json` on 2026-09-02 found THREE blocking-tier hits:
 *
 *   1. product-line.prod-cream   disease:"eczema"        ← fixed here
 *   2. featured-testimonial      eczema, prescription, steroids
 *   3. founder.founder-body      disease:"eczema"
 *
 * (2) and (3) are deliberately NOT touched. (2) is a verbatim CUSTOMER
 * testimonial — an advertiser may not put words in an endorser's mouth, so the
 * options there are swap it for a compliant review or drop the section, which
 * is an operator decision about the homepage's primary social proof, not a copy
 * edit. It is also the exact shape CLAUDE.md records from 2026-08-16: a
 * correctly-SOURCED review that still fails the health gate, because the FTC
 * holds an advertiser responsible for what an endorsement conveys. (3) is the
 * founder's own words about his family, and "eczema-prone" is the same
 * grammatical shape as the "Oily or Acne-Prone Skin" framing CLAUDE.md
 * explicitly keeps. Neither is mine to rewrite unasked.
 *
 * THE EDIT
 *   before  For dry patches, eczema, and overnight repair.
 *   after   For dry patches, rough elbows, and overnight repair.
 *
 * A named DISEASE is replaced with a cosmetic symptom — "rough elbows" is the
 * wording CLAUDE.md already cites as the acceptable framing in the coconut-oil
 * overnight section. Everything else is left alone on purpose: no therapeutic
 * verb here takes the product as its subject, which is the line the gate's two
 * tiers draw, and over-correcting is the expensive mistake. "overnight repair"
 * does not trip the gate and is kept, because the card must still say what the
 * product is for. Removing "eczema" is also right on strategy independently of
 * compliance — RSC sells no eczema product and may not target one.
 *
 * THIS SCRIPT DOES NOT WRITE TO SHOPIFY. Upload with update-theme-asset.mjs,
 * which backs up the live copy and diffs first:
 *
 *   node scripts/update-theme-asset.mjs get templates/index.json /tmp/idx.json
 *   node scripts/remediate-homepage-card-claims.mjs --in /tmp/idx.json --out /tmp/idx.new.json
 *   node scripts/update-theme-asset.mjs put templates/index.json /tmp/idx.new.json [--apply]
 *
 * IDEMPOTENT, and it SKIPS rather than overwrites when the live value matches
 * neither the BEFORE nor the AFTER — the same guard that caught a transcribed
 * U+00A0 in `remediate-live-health-claims.js`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { serializeTemplate } from './merge-homepage-soap-cards.mjs';

export const PLAN = [
  {
    id: 'card-cream-eczema',
    section: 'product-line',
    block: 'prod-cream',
    field: 'text',
    before: '<p>For dry patches, eczema, and overnight repair.</p><p><a href="/products/coconut-moisturizer"><strong>Shop →</strong></a></p>',
    after: '<p>For dry patches, rough elbows, and overnight repair.</p><p><a href="/products/coconut-moisturizer"><strong>Shop →</strong></a></p>',
    category: 'disease',
    match: 'eczema',
    // The card links to a PDP and sits above a Shop link; a named disease there
    // is an intended-use claim for a cosmetic.
    reason: 'named disease on a card selling a cosmetic, directly above a buy link',
  },
];

/** Hits this script deliberately leaves live, so "we looked" is distinguishable from "we missed". */
export const NOT_REMEDIATED = [
  {
    where: 'featured-testimonial.settings.custom_liquid',
    why: 'verbatim customer endorsement — an advertiser may not rewrite an endorser\'s words; swap or drop is an operator decision',
    categories: ['disease', 'drug'],
  },
  {
    where: 'founder.blocks.founder-body.settings.text',
    why: 'the founder\'s own words; "eczema-prone" is the same shape as the "Acne-Prone Skin" framing that is kept',
    categories: ['disease'],
  },
];

export function applyPlan(template, plan = PLAN) {
  const next = JSON.parse(JSON.stringify(template));
  const applied = [];
  const skipped = [];

  for (const entry of plan) {
    const block = next.sections?.[entry.section]?.blocks?.[entry.block];
    if (!block) { skipped.push({ ...entry, why: 'block not found' }); continue; }
    const live = block.settings?.[entry.field];

    if (live === entry.after) { skipped.push({ ...entry, why: 'already applied' }); continue; }
    if (live !== entry.before) { skipped.push({ ...entry, why: 'live value matches neither BEFORE nor AFTER' }); continue; }

    block.settings[entry.field] = entry.after;
    applied.push(entry);
  }

  return { template: next, applied, skipped };
}

async function main() {
  const arg = (f) => { const i = process.argv.indexOf(f); return i === -1 ? null : process.argv[i + 1]; };
  const input = arg('--in');
  const out = arg('--out');
  if (!input) {
    console.error('usage: remediate-homepage-card-claims.mjs --in <live index.json> [--out <file>]');
    process.exit(2);
  }

  // Every AFTER is re-gated at run time. One failure aborts the whole run.
  for (const e of PLAN) {
    const g = checkSeoCopyFields({ [e.field]: e.after });
    if (!g.ok) throw new Error(`plan entry ${e.id}: AFTER still trips the gate — ${g.blocking.map((v) => `${v.category}:"${v.match}"`).join(', ')}`);
  }
  console.log(`  ✓ all ${PLAN.length} rewrite(s) pass the health-claim gate\n`);

  const template = JSON.parse(readFileSync(input, 'utf8'));
  const { template: next, applied, skipped } = applyPlan(template);

  for (const e of applied) {
    console.log(`  ${e.section}/${e.block}.${e.field}  (${e.category}: "${e.match}")`);
    console.log(`    - ${e.before.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
    console.log(`    + ${e.after.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
  }
  for (const e of skipped) console.log(`  = ${e.id}: ${e.why}`);

  console.log(`\n  LEFT LIVE ON PURPOSE (${NOT_REMEDIATED.length}):`);
  for (const n of NOT_REMEDIATED) console.log(`    ! ${n.where} [${n.categories.join(', ')}] — ${n.why}`);

  if (!applied.length) { console.log('\nNothing to do.'); return; }
  if (!out) { console.log('\nNothing written. Re-run with --out <file>.'); return; }
  writeFileSync(out, serializeTemplate(next));
  console.log(`\n  wrote ${out}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
}
