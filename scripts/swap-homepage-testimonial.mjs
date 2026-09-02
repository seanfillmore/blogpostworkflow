#!/usr/bin/env node
/**
 * Replace the homepage featured testimonial with a gate-clean verified review.
 *
 *   node scripts/swap-homepage-testimonial.mjs --in <live index.json> [--out <file>]
 *
 * WHY IT IS A SWAP AND NOT A REWRITE
 *   The live quote was: "I have horrible eczema and cracked feet. I've tried
 *   prescription lotions, steroids, everything OTC. Nothing worked — until Real
 *   Skin Care. …" — the exact shape CLAUDE.md records from 2026-08-16: a
 *   correctly SOURCED review that still fails the health-claim gate. A cosmetic
 *   positioned against prescription drugs and steroids, with "nothing worked
 *   until", is the classic unapproved-drug shape. The FTC holds an advertiser
 *   responsible for what an endorsement CONVEYS, and the FDA reads testimonials
 *   as evidence of intended use — so "a customer said it" is not a defence.
 *
 *   It is NOT edited down to a compliant subset, because an advertiser may not
 *   put words in an endorser's mouth. The only honest moves are swap or drop.
 *
 * HOW THE REPLACEMENT WAS CHOSEN
 *   All 390 Judge.me reviews were pulled and filtered to 5-star, published,
 *   not hidden, `verified-purchase`, passing BOTH gates (`hasHealthClaim` from
 *   ad-studio and `checkSeoCopyFields`), then de-duplicated: 179 candidates.
 *   Ranked for a hero slot — a real name beats "Anonymous", a concrete detail
 *   beats "love it", and the flagship moisturizer is the biggest revenue
 *   cluster. The winner keeps the persuasive STRUCTURE of the old quote (a real
 *   situation, a result) without any condition, drug or disease language.
 *
 * THE QUOTE IS VERBATIM. Not trimmed, not tidied, not re-punctuated — compare
 * `REPLACEMENT.body` against the API record for review 759721043. Only the
 * ATTRIBUTION is shortened to an initial, matching the surname convention the
 * section already used ("Jessica V.") and keeping the reviewer's full name off
 * a public page. No email, phone or reviewer id from the Judge.me record is
 * written anywhere.
 *
 * REVIEW COUNTS ARE LEFT ALONE. The card claims "380+ verified reviews · 290+
 * five-star ratings"; measured 2026-09-02 the store has 390 and 291. Both
 * claims remain true, so there is nothing to fix and no reason to touch a
 * substantiated number.
 *
 * Upload with update-theme-asset.mjs, which backs up and diffs first. This
 * script writes no Shopify state. IDEMPOTENT, and it SKIPS rather than
 * overwrites when the live markup matches neither BEFORE nor AFTER.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../agents/ad-studio/health-claims.js';
import { serializeTemplate } from './merge-homepage-soap-cards.mjs';

export const SECTION = 'featured-testimonial';
export const FIELD = 'custom_liquid';

/** Provenance for the claim gate's `reviews` source. No PII beyond a first name + initial. */
export const REPLACEMENT = {
  reviewId: 759721043,
  attribution: 'Nicole H.',
  product: 'Coconut Moisturizer | 4oz',
  createdAt: '2025-02-13T23:46:49+00:00',
  verified: 'verified-purchase',
  rating: 5,
  body: "I'm obsessed with all things Real Skin Care. This is THE moisturizer for Wisconsin winters for my whole family. It's long lasting and doesn't feel greasy. We use it all over and love it!",
};

export const OLD_QUOTE = '&ldquo;I have horrible eczema and cracked feet. I\'ve tried prescription lotions, steroids, everything OTC. Nothing worked — until Real Skin Care. Apply morning and night and my skin stays hydrated all day.&rdquo;';
export const OLD_ATTR = '— Jessica V., verified customer';

export const NEW_QUOTE = `&ldquo;${REPLACEMENT.body}&rdquo;`;
export const NEW_ATTR = `— ${REPLACEMENT.attribution}, verified customer`;

/**
 * Swap the quote and attribution inside the section's custom_liquid, leaving
 * the <style> block, the review counters and the "Read more reviews" link
 * untouched. String replacement on the two exact spans rather than a rebuild —
 * the surrounding markup is hand-written and must survive byte-identical.
 */
export function swapTestimonial(template) {
  const next = JSON.parse(JSON.stringify(template));
  const section = next.sections?.[SECTION];
  if (!section) return { template: next, changed: false, why: 'section not found' };

  const live = section.settings?.[FIELD];
  if (typeof live !== 'string') return { template: next, changed: false, why: 'field not found' };
  if (live.includes(NEW_QUOTE) && live.includes(NEW_ATTR)) {
    return { template: next, changed: false, why: 'already applied' };
  }
  if (!live.includes(OLD_QUOTE) || !live.includes(OLD_ATTR)) {
    return { template: next, changed: false, why: 'live markup matches neither BEFORE nor AFTER' };
  }

  section.settings[FIELD] = live.split(OLD_QUOTE).join(NEW_QUOTE).split(OLD_ATTR).join(NEW_ATTR);
  return { template: next, changed: true, why: null };
}

async function main() {
  const arg = (f) => { const i = process.argv.indexOf(f); return i === -1 ? null : process.argv[i + 1]; };
  const input = arg('--in');
  const out = arg('--out');
  if (!input) { console.error('usage: swap-homepage-testimonial.mjs --in <live index.json> [--out <file>]'); process.exit(2); }

  // Both gates, on the replacement, before anything is written.
  const gate = checkSeoCopyFields({ testimonial: REPLACEMENT.body });
  if (!gate.ok) throw new Error(`replacement trips the SEO gate: ${gate.blocking.map((v) => `${v.category}:"${v.match}"`).join(', ')}`);
  if (hasHealthClaim(REPLACEMENT.body)) throw new Error('replacement trips the ad-studio health gate');
  console.log('  ✓ replacement passes both health gates\n');

  const template = JSON.parse(readFileSync(input, 'utf8'));
  const { template: next, changed, why } = swapTestimonial(template);

  console.log(`  - ${OLD_QUOTE.replace(/&[lr]dquo;/g, '"')}`);
  console.log(`    ${OLD_ATTR}`);
  console.log(`\n  + ${NEW_QUOTE.replace(/&[lr]dquo;/g, '"')}`);
  console.log(`    ${NEW_ATTR}`);
  console.log(`\n  source: Judge.me review ${REPLACEMENT.reviewId} · ${REPLACEMENT.rating}★ · ${REPLACEMENT.verified} · ${REPLACEMENT.product} · ${REPLACEMENT.createdAt.slice(0, 10)}`);

  if (!changed) { console.log(`\nNothing to do — ${why}.`); return; }
  if (!out) { console.log('\nNothing written. Re-run with --out <file>.'); return; }
  writeFileSync(out, serializeTemplate(next));
  console.log(`\n  wrote ${out}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
}
